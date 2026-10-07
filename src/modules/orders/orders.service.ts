import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { sha256 } from '../../common/auth/api-key-format.js';
import { type ActorRef, SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import type { AfterEvents } from '../../common/events/base.event.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  Prisma,
  type OrderStatus,
} from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import type { AddressInput, PricedCart } from '../carts/cart-pricer.js';
import { CartPricer } from '../carts/cart-pricer.js';
import { CartsService } from '../carts/carts.service.js';
import { ReservationsService } from '../inventory/reservations.service.js';
import { LoyaltyService } from '../loyalty/loyalty.service.js';
import { RedemptionsService } from '../marketing/redemptions.service.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { formatMoney } from '../pricing/money.js';
import { StoresQuery } from '../stores/stores.query.js';
import { orderAccessToken, uuidFromName } from './order-ids.js';
import {
  ORDER_EVENTS,
  type OrderEventData,
  type OrderRefundedData,
} from './orders.events.js';
import { formatNumber, nextNumber } from './sequences.js';

/** Unpaid orders are cancelled after this long; reservations outlive it a little. */
export const PAYMENT_TIMEOUT_MS = 60 * 60_000;
const RESERVATION_TTL_S = 75 * 60;
const LOCK_TTL_MS = 60_000;

export interface PlacedOrder {
  orderId: string;
  number: string;
  /** Guests read and pay their order with it (customers use their session). */
  accessToken: string;
  created: boolean;
}

interface Compensation {
  reservations: string[];
  promotions: boolean;
  /** The customer whose points were redeemed. */
  pointsOf: string | null;
}

/**
 * Orders (PLAN.md §4 request path). Placing an order is a saga over module boundaries, each step
 * idempotent per order id (derived from the cart and the Idempotency-Key): reserve stock → record
 * promotion use → redeem points → write the order. A failing step undoes the ones before it; a
 * retry with the same key resumes and returns the same order.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly carts: CartsService,
    private readonly pricer: CartPricer,
    private readonly reservations: ReservationsService,
    private readonly redemptions: RedemptionsService,
    private readonly loyalty: LoyaltyService,
    private readonly stores: StoresQuery,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private token(orderId: string): string {
    return orderAccessToken(
      this.config.get('auth', { infer: true }).jwtSecret,
      orderId,
    );
  }

  async place(
    ctx: StoreContext,
    cartToken: string | undefined,
    idempotencyKey: string,
  ): Promise<PlacedOrder> {
    if (!/^[\w.:-]{8,100}$/.test(idempotencyKey))
      throw new BadRequestException(
        'Send an Idempotency-Key header (8–100 letters, digits, ".", ":", "-" or "_")',
      );
    const existing = await this.prisma.order.findUnique({
      where: {
        storeId_idempotencyKey: { storeId: ctx.storeId, idempotencyKey },
      },
      select: { id: true, number: true },
    });
    if (existing)
      return {
        orderId: existing.id,
        number: existing.number,
        accessToken: this.token(existing.id),
        created: false,
      };

    const lockKey = `checkout:lock:${ctx.storeId}:${idempotencyKey}`;
    const locked = await this.redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!locked)
      throw new ConflictException(
        'This order is being placed; retry in a moment with the same Idempotency-Key',
      );
    try {
      const cart = await this.carts.require(ctx, cartToken);
      const priced = await this.pricer.price(cart, {
        localeCode: ctx.localeCode,
      });
      if (priced.missing.length)
        throw new BadRequestException({
          message: `Checkout isn't complete: ${priced.missing.join(', ')}`,
          missing: priced.missing,
          warnings: priced.warnings,
        });
      const orderId = uuidFromName(`order:${cart.id}:${idempotencyKey}`);
      const done: Compensation = {
        reservations: [],
        promotions: false,
        pointsOf: null,
      };
      try {
        const groups = await this.reserve(orderId, priced, done);
        await this.redemptions.redeemEvaluation(
          {
            orderRef: orderId,
            customerId: cart.customerId,
            currencyCode: cart.currencyCode,
            evaluation: priced.evaluation,
          },
          SYSTEM_ACTOR,
        );
        done.promotions = priced.evaluation.result.applied.length > 0;
        if (priced.loyaltyPoints > 0) {
          await this.loyalty.redeem(
            cart.customerId!,
            {
              orderRef: orderId,
              points: priced.loyaltyPoints,
              orderAmount: Number(priced.grandTotal),
            },
            SYSTEM_ACTOR,
          );
          done.pointsOf = cart.customerId;
        }
        const number = await this.write(
          orderId,
          idempotencyKey,
          ctx,
          priced,
          groups,
        );
        return {
          orderId,
          number,
          accessToken: this.token(orderId),
          created: true,
        };
      } catch (e) {
        // A concurrent request with the same key won: its order stands, nothing to undo.
        if (isUnique(e, 'uq_orders_store_id_idempotency_key')) {
          const o = await this.prisma.order.findUniqueOrThrow({
            where: { id: orderId },
            select: { number: true },
          });
          return {
            orderId,
            number: o.number,
            accessToken: this.token(orderId),
            created: false,
          };
        }
        await this.compensate(orderId, done);
        if (isUnique(e, 'uq_orders_cart_id'))
          throw new ConflictException(
            'An order was already placed from this cart',
          );
        throw e;
      }
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /** Reserves stock per line (bundle components separately); returns line → group ids. */
  private async reserve(
    orderId: string,
    priced: PricedCart,
    done: Compensation,
  ): Promise<Map<string, string>> {
    const groups = new Map<string, string>();
    const reserve = async (
      key: string,
      variantId: string,
      quantity: number,
    ) => {
      const groupId = uuidFromName(`reservation:${orderId}:${key}`);
      const r = await this.reservations.reserve({
        websiteId: priced.ctx.websiteId,
        variantId,
        quantity,
        referenceType: 'ORDER',
        referenceId: orderId,
        ttlSeconds: RESERVATION_TTL_S,
        groupId,
      });
      if (r.managed) {
        groups.set(key, groupId);
        done.reservations.push(groupId);
      }
    };
    for (const l of priced.lines.filter((x) => x.available)) {
      if (l.components.length)
        for (const c of l.components)
          await reserve(
            `${l.itemId}:${c.variantId}`,
            c.variantId,
            c.quantity * l.quantity,
          );
      else await reserve(l.itemId, l.variantId, l.quantity);
    }
    return groups;
  }

  private async compensate(orderId: string, done: Compensation): Promise<void> {
    const undo = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        this.logger.error(
          `Checkout ${orderId}: could not undo ${what}: ${(e as Error).message}`,
        );
      }
    };
    for (const g of done.reservations)
      await undo(`reservation ${g}`, () => this.reservations.release(g));
    if (done.promotions)
      await undo('promotion use', () =>
        this.redemptions.release(orderId, SYSTEM_ACTOR),
      );
    const customerId = done.pointsOf;
    if (customerId)
      await undo('points', () =>
        this.loyalty.reverse(
          customerId,
          { orderRef: orderId, restoreRedeemed: true },
          SYSTEM_ACTOR,
        ),
      );
  }

  private async write(
    orderId: string,
    idempotencyKey: string,
    ctx: StoreContext,
    p: PricedCart,
    groups: Map<string, string>,
  ): Promise<string> {
    const snap = await this.stores.snapshot();
    const websiteCode = snap.byId.get(ctx.storeId)?.websiteCode ?? 'shop';
    const shipping = p.cart.shippingAddress as unknown as AddressInput | null;
    const billing = (p.cart.billingAddress ??
      p.cart.shippingAddress) as unknown as AddressInput | null;
    const email = p.cart.email ?? ctx.customer?.email ?? null;
    if (!email) throw new BadRequestException("Checkout isn't complete: email");
    const paidInFull = p.amountDue === 0n;
    return this.bus.write({
      before: new BeforeWriteEvent(
        ORDER_EVENTS.BEFORE_WRITE,
        'place',
        orderId,
        actorFor(p),
        {
          cartId: p.cart.id,
        },
      ),
      work: async (tx, after) => {
        const number = formatNumber(
          websiteCode.toUpperCase(),
          await nextNumber(tx, `order:${websiteCode}`),
        );
        const status: OrderStatus = paidInFull
          ? 'PROCESSING'
          : 'PENDING_PAYMENT';
        await tx.order.create({
          data: {
            id: orderId,
            number,
            storeId: ctx.storeId,
            websiteId: ctx.websiteId,
            customerId: p.cart.customerId,
            cartId: p.cart.id,
            idempotencyKey,
            accessTokenHash: sha256(this.token(orderId)),
            email,
            customerGroupCode: p.customerGroupCode,
            localeCode: ctx.localeCode,
            currencyCode: p.cart.currencyCode,
            status,
            paymentStatus: paidInFull ? 'PAID' : 'UNPAID',
            paidAt: paidInFull ? new Date() : null,
            pricesIncludeTax: ctx.pricesIncludeTax,
            subtotal: p.subtotal,
            discountTotal: p.discountTotal,
            shippingTotal: p.shippingAmount - p.shippingDiscount,
            taxTotal: p.taxTotal,
            grandTotal: p.grandTotal,
            loyaltyPoints: p.loyaltyPoints,
            loyaltyAmount: p.loyaltyAmount,
            amountDue: p.amountDue,
            amountPaid: 0n,
            couponCode:
              p.evaluation.coupon?.status === 'APPLIED'
                ? p.evaluation.coupon.code
                : null,
            shippingMethodCode: p.shipping?.code ?? null,
            shippingMethodName: p.shipping?.name ?? null,
            discounts: p.evaluation.result.applied.map((a) => ({
              promotionId: a.promotionId,
              label: a.label,
              discount: a.discount.toString(),
              couponCode: a.couponCode,
            })),
            taxBreakdown: p.taxBreakdown.map((t) => ({
              name: t.name,
              rate: t.rate,
              amount: t.amount.toString(),
            })),
            addresses: {
              create: [
                ...(shipping && p.requiresShipping
                  ? [{ type: 'SHIPPING' as const, ...address(shipping) }]
                  : []),
                ...(billing
                  ? [{ type: 'BILLING' as const, ...address(billing) }]
                  : []),
              ],
            },
            history: {
              create: {
                event: 'placed',
                message: `Order ${number} placed`,
                actorLabel: actorFor(p).label,
                isPublic: true,
              },
            },
          },
        });
        for (const l of p.lines.filter((x) => x.available)) {
          const parent = await tx.orderItem.create({
            data: {
              orderId,
              productId: l.productId,
              variantId: l.variantId,
              sku: l.sku,
              name: l.name,
              productType: l.type as never,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              rowTotal: l.rowTotal,
              discount: l.discount,
              taxAmount: l.taxAmount,
              taxRate: new Prisma.Decimal(l.taxRate),
              options: {
                attributes: l.attributes,
                choices: l.options,
              } as unknown as Prisma.InputJsonValue,
              reservationGroupId: groups.get(l.itemId) ?? null,
            },
            select: { id: true },
          });
          for (const c of l.components)
            await tx.orderItem.create({
              data: {
                orderId,
                parentItemId: parent.id,
                variantId: c.variantId,
                sku: c.sku,
                name: `${l.name} — ${c.sku}`,
                productType: 'SIMPLE',
                quantity: c.quantity * l.quantity,
                unitPrice: 0n,
                rowTotal: 0n,
                reservationGroupId:
                  groups.get(`${l.itemId}:${c.variantId}`) ?? null,
              },
            });
        }
        const data = eventData(
          {
            id: orderId,
            number,
            storeId: ctx.storeId,
            websiteId: ctx.websiteId,
            customerId: p.cart.customerId,
          },
          p.cart.id,
        );
        after.add(
          new EntityEvent<OrderEventData>(
            ORDER_EVENTS.PLACED,
            actorFor(p),
            'order',
            orderId,
            {
              number,
              grandTotal: p.grandTotal.toString(),
              currency: p.cart.currencyCode,
            },
            data,
          ),
        );
        if (paidInFull)
          after.add(
            new EntityEvent<OrderEventData>(
              ORDER_EVENTS.PAID,
              SYSTEM_ACTOR,
              'order',
              orderId,
              { amountPaid: '0' },
              data,
            ),
          );
        return number;
      },
    });
  }

  /** Cash on delivery accepted: processed now, paid at delivery. */
  async accept(orderId: string): Promise<void> {
    await this.transition(orderId, 'accept', async (tx, o, after) => {
      if (o.status !== 'PENDING_PAYMENT') return;
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'PROCESSING', version: { increment: 1 } },
      });
      await history(
        tx,
        orderId,
        'accepted',
        'Cash on delivery: the order is being processed',
        true,
      );
      after.add(
        new EntityEvent<OrderEventData>(
          ORDER_EVENTS.ACCEPTED,
          SYSTEM_ACTOR,
          'order',
          orderId,
          {},
          eventData(o),
        ),
      );
    });
  }

  /**
   * Payments captured: `totalCaptured` is the sum over the order's captured payments, so the call is
   * idempotent. Paid in full → invoice, PROCESSING (or COMPLETE when already fulfilled).
   */
  async recordPayment(orderId: string, totalCaptured: bigint): Promise<void> {
    await this.transition(orderId, 'payment', async (tx, o, after) => {
      if (totalCaptured <= o.amountPaid) return;
      if (o.status === 'CANCELED' || o.status === 'CLOSED') {
        // Money for an order that no longer sells anything: recorded, and refunded by payments.
        await tx.order.update({
          where: { id: orderId },
          data: { amountPaid: totalCaptured, version: { increment: 1 } },
        });
        await history(
          tx,
          orderId,
          'paid',
          'A payment arrived after the order was closed; it is refunded',
          false,
        );
        return;
      }
      const paid = totalCaptured >= o.amountDue;
      const status: OrderStatus = paid
        ? o.fulfillmentStatus === 'FULFILLED'
          ? 'COMPLETE'
          : 'PROCESSING'
        : o.status;
      await tx.order.update({
        where: { id: orderId },
        data: {
          amountPaid: totalCaptured,
          ...(paid && o.paymentStatus === 'UNPAID'
            ? { paymentStatus: 'PAID', paidAt: new Date() }
            : {}),
          status,
          version: { increment: 1 },
        },
      });
      await history(
        tx,
        orderId,
        'paid',
        paid ? 'Payment received' : 'Partial payment received',
        true,
      );
      if (paid && o.paymentStatus === 'UNPAID') {
        await this.issueInvoice(tx, o);
        after.add(
          new EntityEvent<OrderEventData>(
            ORDER_EVENTS.PAID,
            SYSTEM_ACTOR,
            'order',
            orderId,
            {
              amountPaid: totalCaptured.toString(),
            },
            eventData(o),
          ),
        );
        if (status === 'COMPLETE')
          after.add(
            new EntityEvent<OrderEventData>(
              ORDER_EVENTS.COMPLETED,
              SYSTEM_ACTOR,
              'order',
              orderId,
              {},
              eventData(o),
            ),
          );
      }
    });
  }

  private async issueInvoice(
    tx: PrismaTransaction,
    o: OrderState,
  ): Promise<void> {
    const year = new Date().getUTCFullYear();
    const n = await nextNumber(tx, `invoice:${o.websiteCode}:${year}`);
    await tx.invoice.create({
      data: {
        orderId: o.id,
        number: formatNumber(`INV-${o.websiteCode.toUpperCase()}-${year}`, n),
        currencyCode: o.currencyCode,
        subtotal: o.subtotal,
        discountTotal: o.discountTotal,
        shippingTotal: o.shippingTotal,
        taxTotal: o.taxTotal,
        grandTotal: o.grandTotal,
      },
    });
  }

  /**
   * A succeeded refund: amounts, refunded quantities, credit memo, status (REFUNDED → CLOSED).
   * Idempotent per refund (one credit memo per refund).
   */
  async recordRefund(input: {
    orderId: string;
    refundId: string;
    amount: bigint;
    totalRefunded: bigint;
    totalCaptured: bigint;
    items: { orderItemId: string; quantity: number }[];
    restock: boolean;
  }): Promise<void> {
    await this.transition(input.orderId, 'refund', async (tx, o, after) => {
      if (
        await tx.creditMemo.findUnique({
          where: { refundId: input.refundId },
          select: { id: true },
        })
      )
        return;
      // Refunds can be handled before the capture event: take the paid amount from the refund too.
      const paid =
        input.totalCaptured > o.amountPaid ? input.totalCaptured : o.amountPaid;
      const full = paid > 0n && input.totalRefunded >= paid;
      const restock: OrderRefundedData['restock'] = [];
      for (const it of input.items) {
        const item = await tx.orderItem.findFirst({
          where: { id: it.orderItemId, orderId: o.id },
          select: {
            id: true,
            quantity: true,
            qtyRefunded: true,
            reservationGroupId: true,
            children: { select: { reservationGroupId: true, quantity: true } },
          },
        });
        if (!item) continue;
        const qty = Math.min(it.quantity, item.quantity - item.qtyRefunded);
        if (qty <= 0) continue;
        await tx.orderItem.update({
          where: { id: item.id },
          data: { qtyRefunded: { increment: qty } },
        });
        if (input.restock) {
          if (item.reservationGroupId)
            restock.push({
              reservationGroupId: item.reservationGroupId,
              quantity: qty,
            });
          for (const c of item.children)
            if (c.reservationGroupId)
              restock.push({
                reservationGroupId: c.reservationGroupId,
                quantity: (c.quantity / item.quantity) * qty,
              });
        }
      }
      const year = new Date().getUTCFullYear();
      const n = await nextNumber(tx, `credit-memo:${o.websiteCode}:${year}`);
      const taxAmount =
        o.grandTotal > 0n ? (o.taxTotal * input.amount) / o.grandTotal : 0n;
      await tx.creditMemo.create({
        data: {
          orderId: o.id,
          refundId: input.refundId,
          number: formatNumber(`CM-${o.websiteCode.toUpperCase()}-${year}`, n),
          currencyCode: o.currencyCode,
          amount: input.amount,
          taxAmount: taxAmount > input.amount ? input.amount : taxAmount,
        },
      });
      await tx.order.update({
        where: { id: o.id },
        data: {
          amountPaid: paid,
          amountRefunded:
            input.totalRefunded > paid ? paid : input.totalRefunded,
          paymentStatus: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          // A cancelled order stays cancelled; a fully refunded one is closed.
          ...(full && o.status !== 'CANCELED' ? { status: 'CLOSED' } : {}),
          version: { increment: 1 },
        },
      });
      const minor =
        (await this.stores.snapshot()).currencies.get(o.currencyCode)
          ?.minorUnits ?? 2;
      await history(
        tx,
        o.id,
        'refunded',
        `Refund of ${formatMoney(input.amount, o.currencyCode, minor, 'en-US')} issued`,
        true,
      );
      after.add(
        new EntityEvent<OrderRefundedData>(
          ORDER_EVENTS.REFUNDED,
          SYSTEM_ACTOR,
          'order',
          o.id,
          {
            amount: input.amount.toString(),
            full,
          },
          {
            ...eventData(o),
            refundId: input.refundId,
            amount: input.amount.toString(),
            full,
            restock,
          },
        ),
      );
    });
  }

  /** Cancels an unpaid, unshipped order (shopper, staff or the payment timeout). */
  async cancel(
    orderId: string,
    actor: ActorRef,
    reason: string,
  ): Promise<void> {
    await this.transition(
      orderId,
      'cancel',
      async (tx, o, after) => {
        if (o.status === 'CANCELED') return;
        if (o.paymentStatus !== 'UNPAID' || o.amountPaid > 0n)
          throw new ConflictException('The order is paid: refund it instead');
        if (o.fulfillmentStatus !== 'UNFULFILLED')
          throw new ConflictException(
            'The order has shipped and can’t be cancelled',
          );
        if (!['PENDING_PAYMENT', 'PROCESSING'].includes(o.status))
          throw new ConflictException(
            `A ${o.status.toLowerCase()} order can’t be cancelled`,
          );
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'CANCELED',
            canceledAt: new Date(),
            version: { increment: 1 },
          },
        });
        await history(tx, orderId, 'canceled', reason, true, actor.label);
        after.add(
          new EntityEvent<OrderEventData>(
            ORDER_EVENTS.CANCELED,
            actor,
            'order',
            orderId,
            { reason },
            eventData(o),
          ),
        );
      },
      actor,
    );
  }

  /** Job: cancels orders left unpaid past the payment timeout. */
  async expireUnpaid(now = new Date()): Promise<number> {
    const stale = await this.prisma.order.findMany({
      where: {
        status: 'PENDING_PAYMENT',
        placedAt: { lt: new Date(now.getTime() - PAYMENT_TIMEOUT_MS) },
      },
      select: { id: true },
      take: 500,
    });
    let n = 0;
    for (const o of stale)
      try {
        await this.cancel(o.id, SYSTEM_ACTOR, 'Not paid in time');
        n++;
      } catch (e) {
        this.logger.warn(
          `Could not expire order ${o.id}: ${(e as Error).message}`,
        );
      }
    return n;
  }

  /** Ships lines (all remaining shippable units when `items` is omitted). */
  async ship(
    orderId: string,
    input: {
      carrier: string;
      trackingNumber?: string;
      trackingUrl?: string;
      items?: { orderItemId: string; quantity: number }[];
    },
    actor: ActorRef,
  ): Promise<string> {
    return this.transition(
      orderId,
      'ship',
      async (tx, o, after) => {
        if (o.status !== 'PROCESSING')
          throw new ConflictException(
            o.status === 'PENDING_PAYMENT'
              ? 'The order is not paid yet'
              : `A ${o.status.toLowerCase()} order can’t be shipped`,
          );
        const lines = await tx.orderItem.findMany({
          where: {
            orderId,
            parentItemId: null,
            productType: { not: 'VIRTUAL' },
          },
          select: {
            id: true,
            quantity: true,
            qtyShipped: true,
            qtyRefunded: true,
          },
        });
        const open = (l: (typeof lines)[number]) =>
          l.quantity - l.qtyShipped - l.qtyRefunded;
        const wanted =
          input.items ??
          lines
            .filter((l) => open(l) > 0)
            .map((l) => ({ orderItemId: l.id, quantity: open(l) }));
        if (!wanted.length) throw new ConflictException('Nothing left to ship');
        for (const w of wanted) {
          const l = lines.find((x) => x.id === w.orderItemId);
          if (!l)
            throw new BadRequestException(
              `Item ${w.orderItemId} is not a shippable line of this order`,
            );
          if (w.quantity > open(l))
            throw new BadRequestException(
              `Only ${open(l)} of item ${l.id} can ship`,
            );
        }
        const n = await nextNumber(tx, `shipment:${o.websiteCode}`);
        const number = formatNumber(`SH-${o.websiteCode.toUpperCase()}`, n);
        await tx.shipment.create({
          data: {
            orderId,
            number,
            carrier: input.carrier,
            trackingNumber: input.trackingNumber ?? null,
            trackingUrl: input.trackingUrl ?? null,
            items: {
              create: wanted.map((w) => ({
                orderItemId: w.orderItemId,
                quantity: w.quantity,
              })),
            },
          },
        });
        for (const w of wanted)
          await tx.orderItem.update({
            where: { id: w.orderItemId },
            data: { qtyShipped: { increment: w.quantity } },
          });
        const after2 = await tx.orderItem.findMany({
          where: {
            orderId,
            parentItemId: null,
            productType: { not: 'VIRTUAL' },
          },
          select: { quantity: true, qtyShipped: true, qtyRefunded: true },
        });
        const fulfilled = after2.every(
          (l) => l.qtyShipped + l.qtyRefunded >= l.quantity,
        );
        const complete = fulfilled && o.paymentStatus !== 'UNPAID';
        await tx.order.update({
          where: { id: orderId },
          data: {
            fulfillmentStatus: fulfilled ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
            ...(complete ? { status: 'COMPLETE' } : {}),
            version: { increment: 1 },
          },
        });
        await history(
          tx,
          orderId,
          'shipped',
          `Shipment ${number} sent with ${input.carrier}${input.trackingNumber ? ` (tracking ${input.trackingNumber})` : ''}`,
          true,
          actor.label,
        );
        after.add(
          new EntityEvent<OrderEventData>(
            ORDER_EVENTS.SHIPPED,
            actor,
            'order',
            orderId,
            { shipment: number },
            eventData(o),
          ),
        );
        if (complete)
          after.add(
            new EntityEvent<OrderEventData>(
              ORDER_EVENTS.COMPLETED,
              SYSTEM_ACTOR,
              'order',
              orderId,
              {},
              eventData(o),
            ),
          );
        return number;
      },
      actor,
    );
  }

  async deliver(shipmentId: string, actor: ActorRef): Promise<void> {
    const s = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { orderId: true, status: true, number: true },
    });
    if (!s) throw new NotFoundException(`Shipment ${shipmentId} not found`);
    await this.transition(
      s.orderId,
      'deliver',
      async (tx, o, after) => {
        const { count } = await tx.shipment.updateMany({
          where: { id: shipmentId, status: 'SHIPPED' },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        });
        if (!count) return;
        await history(
          tx,
          o.id,
          'delivered',
          `Shipment ${s.number} delivered`,
          true,
          actor.label,
        );
        after.add(
          new EntityEvent<OrderEventData>(
            ORDER_EVENTS.DELIVERED,
            actor,
            'order',
            o.id,
            { shipment: s.number },
            eventData(o),
          ),
        );
      },
      actor,
    );
  }

  async addNote(
    orderId: string,
    message: string,
    isPublic: boolean,
    actor: ActorRef,
  ): Promise<void> {
    await this.transition(
      orderId,
      'note',
      async (tx, o, after) => {
        await history(tx, orderId, 'note', message, isPublic, actor.label);
        after.add(
          new EntityEvent(
            ORDER_EVENTS.NOTE_ADDED,
            actor,
            'order',
            orderId,
            { isPublic },
            eventData(o),
          ),
        );
      },
      actor,
    );
  }

  // ─── internals ───

  /** Locks the order row and runs a state change in one transaction. */
  private transition<T>(
    orderId: string,
    action: string,
    work: (
      tx: PrismaTransaction,
      o: OrderState,
      after: AfterEvents,
    ) => Promise<T>,
    actor: ActorRef = SYSTEM_ACTOR,
  ): Promise<T> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        ORDER_EVENTS.BEFORE_WRITE,
        action,
        orderId,
        actor,
      ),
      work: async (tx, after) => {
        const [o] = await tx.$queryRaw<OrderState[]>`
          SELECT o.id, o.number, o.store_id AS "storeId", o.website_id AS "websiteId", w.code AS "websiteCode",
                 o.customer_id AS "customerId", o.status, o.payment_status AS "paymentStatus",
                 o.fulfillment_status AS "fulfillmentStatus", o.currency_code AS "currencyCode",
                 o.subtotal, o.discount_total AS "discountTotal", o.shipping_total AS "shippingTotal",
                 o.tax_total AS "taxTotal", o.grand_total AS "grandTotal", o.amount_due AS "amountDue",
                 o.amount_paid AS "amountPaid"
            FROM orders o JOIN websites w ON w.id = o.website_id
           WHERE o.id = ${orderId}::uuid FOR UPDATE OF o`;
        if (!o) throw new NotFoundException(`Order ${orderId} not found`);
        return work(tx, o, after);
      },
    });
  }
}

interface OrderState {
  id: string;
  number: string;
  storeId: string;
  websiteId: string;
  websiteCode: string;
  customerId: string | null;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentStatus: string;
  currencyCode: string;
  subtotal: bigint;
  discountTotal: bigint;
  shippingTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  amountDue: bigint;
  amountPaid: bigint;
}

function eventData(
  o: Pick<OrderState, 'id' | 'number' | 'storeId' | 'websiteId' | 'customerId'>,
  cartId?: string,
): OrderEventData {
  return {
    orderId: o.id,
    number: o.number,
    storeId: o.storeId,
    websiteId: o.websiteId,
    customerId: o.customerId,
    ...(cartId ? { cartId } : {}),
  };
}

function actorFor(p: PricedCart): ActorRef {
  return p.cart.customerId
    ? {
        type: 'customer',
        id: p.cart.customerId,
        label: p.cart.email ?? 'customer',
      }
    : { type: 'system', id: null, label: `guest ${p.cart.email ?? ''}`.trim() };
}

function address(a: AddressInput) {
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    company: a.company ?? null,
    phone: a.phone ?? null,
    countryCode: a.countryCode,
    regionCode: a.regionCode ?? null,
    city: a.city,
    postcode: a.postcode ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
  };
}

async function history(
  tx: PrismaTransaction,
  orderId: string,
  event: string,
  message: string,
  isPublic: boolean,
  actorLabel = 'system',
): Promise<void> {
  await tx.orderHistory.create({
    data: {
      orderId,
      event,
      message: message.slice(0, 1000),
      isPublic,
      actorLabel: actorLabel.slice(0, 255),
    },
  });
}

function isUnique(e: unknown, constraint: string): boolean {
  if (
    !(e instanceof Prisma.PrismaClientKnownRequestError) ||
    e.code !== 'P2002'
  )
    return false;
  return JSON.stringify(e.meta ?? {}).includes(constraint);
}
