import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { type ActorRef, SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import type { AfterEvents } from '../../common/events/base.event.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { OrdersQuery } from '../orders/orders.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import type { CreateRefundDto } from './dto/payments.dto.js';
import { PAYMENT_EVENTS, type PaymentRefundedData } from './payments.events.js';
import { PaymentAdapters } from './providers/registry.js';
import type { RefundResult, StoredPayment } from './providers/types.js';

export const REFUND_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  amount: true,
  currencyCode: true,
  status: true,
  reason: true,
  items: true,
  restock: true,
  providerRef: true,
  failureReason: true,
  createdAt: true,
} as const satisfies Prisma.RefundSelect;

export type RefundRow = Prisma.RefundGetPayload<{
  select: typeof REFUND_SELECT;
}>;

/** Refunds answered as pending are checked again after this long. */
const SETTLE_AFTER_MS = 5 * 60_000;

const PENDING_SELECT = {
  ...REFUND_SELECT,
  payment: {
    select: {
      id: true,
      providerRef: true,
      captureRef: true,
      amount: true,
      currencyCode: true,
      createdAt: true,
      capturedAt: true,
      provider: {
        select: { id: true, code: true, mode: true, credentials: true },
      },
    },
  },
} as const satisfies Prisma.RefundSelect;

type PendingRefund = Prisma.RefundGetPayload<{
  select: typeof PENDING_SELECT;
}>;

/**
 * Refunds (PLAN.md §9.6) against a captured payment, through its provider. Idempotent per
 * Idempotency-Key; never more than was paid and not yet refunded. A succeeded refund emits
 * `payment.refunded` with the order's refunded total (orders: credit memo, restock, points).
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly orders: OrdersQuery,
    private readonly adapters: PaymentAdapters,
    private readonly stores: StoresQuery,
  ) {}

  async refund(
    orderId: string,
    dto: CreateRefundDto,
    idempotencyKey: string | undefined,
    actor: ActorRef,
  ): Promise<RefundRow> {
    if (idempotencyKey) {
      const existing = await this.prisma.refund.findUnique({
        where: { orderId_idempotencyKey: { orderId, idempotencyKey } },
        select: REFUND_SELECT,
      });
      if (existing) return existing;
    }
    const facts = await this.orders.paymentFacts(orderId);
    const effects = await this.orders.effects(orderId);
    // From the payments themselves: the order's own totals are updated asynchronously.
    const [captured, committed] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { orderId, status: 'CAPTURED' },
        _sum: { amount: true },
      }),
      this.prisma.refund.aggregate({
        where: { orderId, status: { in: ['SUCCEEDED', 'PENDING'] } },
        _sum: { amount: true },
      }),
    ]);
    const refundable =
      (captured._sum.amount ?? 0n) - (committed._sum.amount ?? 0n);
    if (refundable <= 0n)
      throw new ConflictException('Nothing left to refund on this order');

    const items = dto.items ?? [];
    let fromItems = 0n;
    for (const it of items) {
      const line = effects.items.find(
        (i) => i.id === it.orderItemId && !i.parentItemId,
      );
      if (!line)
        throw new BadRequestException(
          `Item ${it.orderItemId} is not a line of this order`,
        );
      if (it.quantity > line.quantity - line.qtyRefunded)
        throw new BadRequestException(
          `Only ${line.quantity - line.qtyRefunded} of ${line.sku} can be refunded`,
        );
      const value =
        line.rowTotal -
        line.discount +
        (effects.pricesIncludeTax ? 0n : line.taxAmount);
      fromItems += (value * BigInt(it.quantity)) / BigInt(line.quantity);
    }
    const amount =
      dto.amount !== undefined
        ? BigInt(dto.amount)
        : items.length
          ? fromItems
          : refundable;
    if (amount <= 0n)
      throw new BadRequestException('The refund amount must be positive');
    if (amount > refundable)
      throw new BadRequestException(
        `At most ${refundable} (minor units) can still be refunded`,
      );

    const payments = await this.prisma.payment.findMany({
      where: { orderId, status: 'CAPTURED' },
      select: {
        id: true,
        amount: true,
        refunds: {
          where: { status: { in: ['SUCCEEDED', 'PENDING'] } },
          select: { amount: true },
        },
      },
      orderBy: { capturedAt: 'asc' },
    });
    const target = payments.find(
      (p) => p.amount - p.refunds.reduce((s, r) => s + r.amount, 0n) >= amount,
    );
    if (!target)
      throw new BadRequestException(
        'No single payment covers this amount; refund each payment separately',
      );

    const refund = await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'refund',
        target.id,
        actor,
        {
          orderId,
          amount: amount.toString(),
        },
      ),
      work: (tx) =>
        tx.refund.create({
          data: {
            orderId,
            paymentId: target.id,
            amount,
            currencyCode: facts.currencyCode,
            reason: dto.reason ?? null,
            items: items as unknown as Prisma.InputJsonValue,
            restock: dto.restock ?? false,
            idempotencyKey: idempotencyKey ?? null,
            createdById: actor.type === 'admin' ? actor.id : null,
          },
          select: REFUND_SELECT,
        }),
    });
    return this.execute(refund.id, actor);
  }

  /** A payment captured on an order that can't take it (cancelled, or paid twice): give it back. */
  async autoRefund(
    paymentId: string,
    reason: string,
    actor: ActorRef,
  ): Promise<void> {
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { orderId: true, amount: true, amountRefunded: true },
    });
    const left = p.amount - p.amountRefunded;
    if (left <= 0n) return;
    await this.refund(
      p.orderId,
      { amount: Number(left), reason },
      `auto-${paymentId}`,
      actor,
    ).catch((e: Error) =>
      this.logger.error(
        `Automatic refund of payment ${paymentId} failed: ${e.message}`,
      ),
    );
  }

  /** Calls the provider and records the outcome. */
  private async execute(refundId: string, actor: ActorRef): Promise<RefundRow> {
    const r = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: PENDING_SELECT,
    });
    const stored = await this.stored(r.payment);
    let result: RefundResult;
    try {
      result = await this.adapters
        .for(r.payment.provider)
        .refund(stored, r.amount, r.id, r.reason ?? 'Refund');
    } catch (e) {
      result = {
        providerRef: null,
        status: 'FAILED',
        reason: (e as Error).message,
        raw: null,
      };
    }
    // Null only when a concurrent run already recorded it: read it back (never the payment row).
    return (
      (await this.record(r, result, 'api', actor)) ??
      this.prisma.refund.findUniqueOrThrow({
        where: { id: r.id },
        select: REFUND_SELECT,
      })
    );
  }

  /**
   * Job: asks providers about refunds they answered as pending (Stripe, PayPal, MoMo) and records
   * the ones that have since succeeded or failed.
   */
  async settlePending(
    now = new Date(),
    minAgeMs = SETTLE_AFTER_MS,
  ): Promise<{ checked: number; settled: number }> {
    const pending = await this.prisma.refund.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lte: new Date(now.getTime() - minAgeMs) },
      },
      select: PENDING_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let settled = 0;
    for (const r of pending) {
      const adapter = this.adapters.for(r.payment.provider);
      if (!adapter.refundStatus) continue;
      try {
        const result = await adapter.refundStatus(
          await this.stored(r.payment),
          { id: r.id, providerRef: r.providerRef },
        );
        if (result.status === 'PENDING') continue;
        if (await this.record(r, result, 'reconciliation', SYSTEM_ACTOR))
          settled++;
      } catch (e) {
        this.logger.warn(
          `Checking refund ${r.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return { checked: pending.length, settled };
  }

  private async stored(p: PendingRefund['payment']): Promise<StoredPayment> {
    const snap = await this.stores.snapshot();
    return {
      id: p.id,
      providerRef: p.providerRef,
      captureRef: p.captureRef,
      amount: p.amount,
      currencyCode: p.currencyCode,
      minorUnits: snap.currencies.get(p.currencyCode)?.minorUnits ?? 2,
      createdAt: p.createdAt,
      capturedAt: p.capturedAt,
    };
  }

  /**
   * Records a provider's answer on a refund that is still pending (once: a concurrent run finds it
   * settled and returns null).
   */
  private record(
    r: PendingRefund,
    result: RefundResult,
    source: string,
    actor: ActorRef,
  ): Promise<RefundRow | null> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'refund-result',
        r.paymentId,
        actor,
      ),
      work: async (tx, after) => {
        const { count } = await tx.refund.updateMany({
          where: { id: r.id, status: 'PENDING' },
          data: {
            status: result.status,
            providerRef: result.providerRef ?? r.providerRef,
            failureReason: result.reason?.slice(0, 500) ?? null,
          },
        });
        if (!count) return null;
        const updated = await tx.refund.findUniqueOrThrow({
          where: { id: r.id },
          select: REFUND_SELECT,
        });
        await tx.paymentTransaction.create({
          data: {
            paymentId: r.paymentId,
            type: 'REFUND',
            amount: r.amount,
            succeeded: result.status !== 'FAILED',
            providerRef: result.providerRef,
            source,
            raw: sanitize(result.raw),
          },
        });
        if (result.status === 'SUCCEEDED')
          await this.succeeded(tx, after, updated, actor);
        else if (result.status === 'FAILED')
          after.add(
            new EntityEvent(
              PAYMENT_EVENTS.REFUND_FAILED,
              actor,
              'payment',
              r.paymentId,
              {
                refundId: r.id,
                reason: result.reason ?? null,
              },
            ),
          );
        return updated;
      },
    });
  }

  private async succeeded(
    tx: PrismaTransaction,
    after: AfterEvents,
    r: RefundRow,
    actor: ActorRef,
  ): Promise<void> {
    await tx.payment.update({
      where: { id: r.paymentId },
      data: { amountRefunded: { increment: r.amount } },
    });
    const [total, captured] = await Promise.all([
      tx.refund.aggregate({
        where: { orderId: r.orderId, status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({
        where: { orderId: r.orderId, status: 'CAPTURED' },
        _sum: { amount: true },
      }),
    ]);
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: r.paymentId },
      select: { providerCode: true },
    });
    after.add(
      new EntityEvent<PaymentRefundedData>(
        PAYMENT_EVENTS.REFUNDED,
        actor,
        'payment',
        r.paymentId,
        { refundId: r.id, amount: r.amount.toString(), reason: r.reason },
        {
          paymentId: r.paymentId,
          orderId: r.orderId,
          provider: p.providerCode,
          amount: r.amount.toString(),
          refundId: r.id,
          totalRefunded: (total._sum.amount ?? 0n).toString(),
          totalCaptured: (captured._sum.amount ?? 0n).toString(),
          items: r.items as unknown as PaymentRefundedData['items'],
          restock: r.restock,
        },
      ),
    );
  }
}

/** Provider responses are kept for the trail, minus anything that looks like a secret. */
export function sanitize(raw: unknown): Prisma.InputJsonValue {
  const drop = /secret|token|signature|password|key|hash/i;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return '[…]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          drop.test(k) ? '[redacted]' : walk(x, depth + 1),
        ]),
      );
    if (typeof v === 'bigint') return v.toString();
    return v;
  };
  return (walk(raw ?? {}, 0) ?? {}) as Prisma.InputJsonValue;
}
