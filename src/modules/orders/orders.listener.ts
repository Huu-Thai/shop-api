import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import type {
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { CartsService } from '../carts/carts.service.js';
import { ReservationsService } from '../inventory/reservations.service.js';
import { LoyaltyQuery } from '../loyalty/loyalty.query.js';
import { LoyaltyService } from '../loyalty/loyalty.service.js';
import { RedemptionsService } from '../marketing/redemptions.service.js';
import {
  PAYMENT_EVENTS,
  type PaymentEventData,
  type PaymentRefundedData,
} from '../payments/payments.events.js';
import {
  ORDER_EVENTS,
  type OrderEventData,
  type OrderRefundedData,
} from './orders.events.js';
import { OrdersQuery } from './orders.query.js';
import { OrdersService } from './orders.service.js';

const AFTER = { async: true, promisify: true } as const;

/**
 * What follows from order and payment events (after commit, idempotent, retried by the outbox):
 * payments update the order; a paid or accepted order sells its reserved stock and earns points; a
 * cancelled one gives stock, promotion uses and points back; a refund restocks and takes points back.
 */
@Injectable()
export class OrdersListener {
  private readonly logger = new Logger(OrdersListener.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly query: OrdersQuery,
    private readonly carts: CartsService,
    private readonly reservations: ReservationsService,
    private readonly redemptions: RedemptionsService,
    private readonly loyalty: LoyaltyService,
    private readonly loyaltyQuery: LoyaltyQuery,
  ) {}

  // ── Payments → order state.

  @OnEvent(PAYMENT_EVENTS.CAPTURED, AFTER)
  async onCaptured(
    e: ProjectionEvent<PaymentEventData> | EntityEvent<PaymentEventData>,
  ) {
    await this.orders.recordPayment(
      e.data.orderId,
      BigInt(e.data.totalCaptured ?? e.data.amount),
    );
  }

  @OnEvent(PAYMENT_EVENTS.ACCEPTED, AFTER)
  async onAccepted(e: EntityEvent<PaymentEventData>) {
    await this.orders.accept(e.data.orderId);
  }

  @OnEvent(PAYMENT_EVENTS.REFUNDED, AFTER)
  async onRefunded(e: EntityEvent<PaymentRefundedData>) {
    await this.orders.recordRefund({
      orderId: e.data.orderId,
      refundId: e.data.refundId,
      amount: BigInt(e.data.amount),
      totalRefunded: BigInt(e.data.totalRefunded),
      totalCaptured: BigInt(e.data.totalCaptured ?? e.data.totalRefunded),
      items: e.data.items,
      restock: e.data.restock,
    });
  }

  // ── Order state → other modules.

  @OnEvent(ORDER_EVENTS.PLACED, AFTER)
  async onPlaced(e: EntityEvent<OrderEventData>) {
    if (e.data.cartId) await this.carts.convert(e.data.cartId, e.data.orderId);
  }

  @OnEvent(ORDER_EVENTS.ACCEPTED, AFTER)
  async onOrderAccepted(e: EntityEvent<OrderEventData>) {
    await this.sellStock(e.data.orderId);
  }

  @OnEvent(ORDER_EVENTS.PAID, AFTER)
  async onPaid(e: EntityEvent<OrderEventData>) {
    await this.sellStock(e.data.orderId);
    const o = await this.query.effects(e.data.orderId);
    if (!o.customerId || o.amountPaid <= 0n) return;
    const terms = await this.loyaltyQuery.redemptionTerms(o.customerId);
    if (!terms || terms.currencyCode !== o.currencyCode) return;
    await this.loyalty.earn(
      o.customerId,
      {
        orderRef: o.id,
        amount: Number(o.eligible < o.amountPaid ? o.eligible : o.amountPaid),
        currencyCode: o.currencyCode,
      },
      SYSTEM_ACTOR,
    );
  }

  @OnEvent(ORDER_EVENTS.CANCELED, AFTER)
  async onCanceled(e: EntityEvent<OrderEventData>) {
    const o = await this.query.effects(e.data.orderId);
    for (const i of o.items) {
      if (!i.reservationGroupId) continue;
      const r = await this.reservations
        .get(i.reservationGroupId)
        .catch(() => null);
      if (r?.status === 'ACTIVE')
        await this.reservations.release(i.reservationGroupId);
      else if (r?.status === 'CONVERTED')
        await this.reservations.returnStock(
          i.reservationGroupId,
          i.quantity,
          `CANCEL:${o.number}`,
        );
    }
    await ignoreMissing(() => this.redemptions.release(o.id, SYSTEM_ACTOR));
    if (o.customerId && o.loyaltyPoints > 0)
      await ignoreMissing(() =>
        this.loyalty.reverse(
          o.customerId!,
          { orderRef: o.id, restoreRedeemed: true },
          SYSTEM_ACTOR,
        ),
      );
  }

  @OnEvent(ORDER_EVENTS.REFUNDED, AFTER)
  async onOrderRefunded(e: EntityEvent<OrderRefundedData>) {
    for (const r of e.data.restock)
      await this.reservations.returnStock(
        r.reservationGroupId,
        r.quantity,
        `REFUND:${e.data.refundId}`,
      );
    const o = await this.query.effects(e.data.orderId);
    if (!o.customerId) return;
    const base = o.eligible < o.amountPaid ? o.eligible : o.amountPaid;
    await ignoreMissing(() =>
      this.loyalty.reverse(
        o.customerId!,
        e.data.full
          ? { orderRef: o.id, restoreRedeemed: true }
          : {
              orderRef: o.id,
              amount:
                o.amountPaid > 0n
                  ? Number((BigInt(e.data.amount) * base) / o.amountPaid) || 1
                  : 1,
              restoreRedeemed: false,
            },
        SYSTEM_ACTOR,
      ),
    );
  }

  /** Reserved units become sales (ledger SALE). A reservation that lapsed is logged for staff. */
  private async sellStock(orderId: string): Promise<void> {
    const o = await this.query.effects(orderId);
    for (const i of o.items) {
      if (!i.reservationGroupId) continue;
      const r = await this.reservations
        .get(i.reservationGroupId)
        .catch(() => null);
      if (r?.status === 'ACTIVE')
        await this.reservations.convert(
          i.reservationGroupId,
          `ORDER:${o.number}`,
        );
      else if (r && r.status !== 'CONVERTED')
        this.logger.warn(
          `Order ${o.number}: the reservation of ${i.sku} had ${r.status.toLowerCase()} before payment; check stock`,
        );
    }
  }
}

async function ignoreMissing(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof NotFoundException)) throw e;
  }
}
