import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ActorRef, SYSTEM_ACTOR } from '../../common/auth/principal.js';
import type { AfterEvents } from '../../common/events/base.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { localeChain } from '../../common/i18n/locale-chain.js';
import type { AppConfig } from '../../config/configuration.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { formatMoney } from '../pricing/money.js';
import { OrdersQuery, type PaymentFacts } from '../orders/orders.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import type {
  AdminPaymentDto,
  OrderPaymentsDto,
  PaymentDto,
  PaymentMethodDto,
  PayOrderDto,
} from './dto/payments.dto.js';
import { PaymentConfigService } from './payment-config.service.js';
import { PAYMENT_EVENTS, type PaymentEventData } from './payments.events.js';
import { PaymentAdapters, type ProviderRow } from './providers/registry.js';
import {
  type AckReason,
  InvalidSignatureError,
  type PaymentAdapter,
  type ProviderEvent,
  type StoredPayment,
  type WebhookAck,
  type WebhookRequest,
} from './providers/types.js';
import { REFUND_SELECT, RefundsService, sanitize } from './refunds.service.js';

/** Pending payments older than this are asked about by the reconciliation job. */
const RECONCILE_AFTER_MS = 5 * 60_000;

const PAYMENT_SELECT = {
  id: true,
  orderId: true,
  providerId: true,
  providerCode: true,
  status: true,
  amount: true,
  amountRefunded: true,
  currencyCode: true,
  providerRef: true,
  captureRef: true,
  action: true,
  failureReason: true,
  capturedAt: true,
  createdAt: true,
  method: { select: { code: true } },
  provider: { select: { id: true, code: true, mode: true, credentials: true } },
} as const satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/**
 * Payments (PLAN.md §9.6): pay an order with one of its store's methods, follow the provider's
 * protocol (redirect, client secret, cash on delivery), and record the outcome from returns,
 * signed webhooks (de-duplicated per provider event) and reconciliation — each idempotent.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly orders: OrdersQuery,
    private readonly paymentConfig: PaymentConfigService,
    private readonly adapters: PaymentAdapters,
    private readonly refunds: RefundsService,
    private readonly stores: StoresQuery,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private async chain(localeCode: string): Promise<string[]> {
    const { fallbacks } = await this.stores.snapshot();
    return localeChain(localeCode, fallbacks, localeCode);
  }

  private async minorUnits(currency: string): Promise<number> {
    return (
      (await this.stores.snapshot()).currencies.get(currency)?.minorUnits ?? 2
    );
  }

  async methodsForOrder(orderId: string): Promise<PaymentMethodDto[]> {
    const o = await this.orders.paymentFacts(orderId);
    return (await this.offered(o)).map(({ id: _i, providerId: _p, ...m }) => m);
  }

  private async offered(o: PaymentFacts) {
    return this.paymentConfig.eligibleMethods({
      storeId: o.storeId,
      currencyCode: o.currencyCode,
      countryCode: o.billingCountry,
      amount: o.amountDue - o.amountPaid,
      localeChain: await this.chain(o.localeCode),
    });
  }

  /** Starts paying an order (a pending attempt with the same method is shown again). */
  async pay(
    orderId: string,
    dto: PayOrderDto,
    clientIp: string,
  ): Promise<PaymentDto> {
    const o = await this.orders.paymentFacts(orderId);
    if (o.status !== 'PENDING_PAYMENT' || o.amountDue <= o.amountPaid)
      throw new ConflictException('This order is not waiting for payment');
    await this.assertReturnUrl(o.storeId, dto.returnUrl);
    if (dto.cancelUrl) await this.assertReturnUrl(o.storeId, dto.cancelUrl);
    const method = (await this.offered(o)).find((m) => m.code === dto.method);
    if (!method)
      throw new BadRequestException(
        `Payment method "${dto.method}" is not available for this order`,
      );
    const open = await this.prisma.payment.findFirst({
      where: { orderId, status: { in: ['PENDING', 'AWAITING_COLLECTION'] } },
      select: PAYMENT_SELECT,
    });
    if (
      open &&
      open.method?.code === dto.method &&
      open.status === 'PENDING' &&
      open.action
    )
      return this.view(open);
    if (open)
      await this.cancelPayment(open, 'Replaced by another payment attempt');

    const provider = await this.prisma.paymentProvider.findUniqueOrThrow({
      where: { id: method.providerId },
      select: { id: true, code: true, mode: true, credentials: true },
    });
    const amount = o.amountDue - o.amountPaid;
    const created = await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'create',
        orderId,
        SYSTEM_ACTOR,
        { method: dto.method },
      ),
      work: (tx) =>
        tx.payment.create({
          data: {
            orderId,
            methodId: method.id,
            providerId: provider.id,
            providerCode: provider.code,
            amount,
            currencyCode: o.currencyCode,
          },
          select: PAYMENT_SELECT,
        }),
    });
    const adapter = this.adapters.for(provider);
    let result;
    try {
      result = await adapter.createPayment({
        paymentId: created.id,
        amount,
        currencyCode: o.currencyCode,
        minorUnits: await this.minorUnits(o.currencyCode),
        orderId,
        orderNumber: o.number,
        email: o.email,
        localeCode: o.localeCode,
        returnUrl: dto.returnUrl,
        cancelUrl: dto.cancelUrl ?? dto.returnUrl,
        notifyUrl: `${this.config.get('publicUrl', { infer: true })}/api/v1/webhooks/payments/${provider.id}`,
        clientIp,
        createdAt: created.createdAt,
      });
    } catch (e) {
      await this.fail(created.id, (e as Error).message, 'api');
      throw new BadGatewayException(
        `The payment could not be started: ${(e as Error).message}`,
      );
    }
    const updated = await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'initiated',
        created.id,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        const p = await tx.payment.update({
          where: { id: created.id },
          data: {
            providerRef: result.providerRef,
            action: result.action as unknown as Prisma.InputJsonValue,
            status: result.accepted ? 'AWAITING_COLLECTION' : 'PENDING',
          },
          select: PAYMENT_SELECT,
        });
        await tx.paymentTransaction.create({
          data: {
            paymentId: p.id,
            type: 'INITIATE',
            amount,
            succeeded: true,
            providerRef: result.providerRef,
            source: 'api',
            raw: sanitize(result.raw),
          },
        });
        if (result.accepted)
          after.add(
            new EntityEvent<PaymentEventData>(
              PAYMENT_EVENTS.ACCEPTED,
              SYSTEM_ACTOR,
              'payment',
              p.id,
              { provider: p.providerCode },
              {
                paymentId: p.id,
                orderId,
                provider: p.providerCode,
                amount: amount.toString(),
              },
            ),
          );
        return p;
      },
    });
    return this.view(updated);
  }

  /**
   * In production a return URL must be https on the store's own origin or a CORS-allowed storefront
   * origin, so the API can't be used to bounce shoppers to arbitrary sites.
   */
  private async assertReturnUrl(storeId: string, url: string): Promise<void> {
    if (this.config.get('env', { infer: true }) !== 'production') return;
    const u = new URL(url);
    if (u.protocol !== 'https:')
      throw new BadRequestException('returnUrl must be an https URL');
    const store = (await this.stores.snapshot()).byId.get(storeId);
    const allowed = new Set<string>(
      this.config.get('corsOrigins', { infer: true }),
    );
    if (store?.baseUrl) allowed.add(new URL(store.baseUrl).origin);
    if (allowed.size && !allowed.has(u.origin))
      throw new BadRequestException(
        'returnUrl must be on the storefront’s own domain',
      );
  }

  /** The shopper is back from the provider: verify the result (PayPal captures here). */
  async handleReturn(
    orderId: string,
    paymentId: string,
    params: Record<string, string>,
  ): Promise<PaymentDto> {
    const p = await this.load(paymentId);
    if (p.orderId !== orderId)
      throw new NotFoundException(`Payment ${paymentId} not found`);
    if (p.status === 'PENDING') {
      const adapter = this.adapters.for(p.provider);
      let event: ProviderEvent;
      try {
        event = await adapter.handleReturn(await this.stored(p), params);
      } catch (e) {
        if (e instanceof InvalidSignatureError)
          throw new BadRequestException(
            'The payment result could not be verified',
          );
        throw new BadGatewayException((e as Error).message);
      }
      await this.apply(p.provider, event, 'return');
    }
    return this.view(await this.load(paymentId));
  }

  /** A provider notification: verified, de-duplicated, applied; answered the way the provider expects. */
  async webhook(providerId: string, req: WebhookRequest): Promise<WebhookAck> {
    const provider = await this.prisma.paymentProvider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        code: true,
        mode: true,
        credentials: true,
        isActive: true,
      },
    });
    if (!provider) return { status: 404 };
    const adapter = this.adapters.for(provider);
    let event: ProviderEvent;
    try {
      event = await adapter.parseWebhook(req);
    } catch (e) {
      this.logger.warn(
        `Rejected ${provider.code} notification: ${(e as Error).message}`,
      );
      return adapter.ack(
        e instanceof InvalidSignatureError ? 'invalid-signature' : 'error',
      );
    }
    const seen = await this.prisma.paymentWebhookEvent.findUnique({
      where: {
        providerId_providerEventId: {
          providerId,
          providerEventId: event.eventId.slice(0, 128),
        },
      },
      select: { status: true },
    });
    if (seen)
      return adapter.ack(seen.status === 'FAILED' ? 'error' : 'duplicate');
    let reason: AckReason;
    let error: string | null = null;
    try {
      reason = await this.apply(provider, event, 'webhook');
    } catch (e) {
      reason = 'error';
      error = (e as Error).message;
      this.logger.error(
        `Applying ${provider.code} event ${event.eventId} failed: ${error}`,
      );
    }
    await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'webhook',
        providerId,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        await tx.paymentWebhookEvent.createMany({
          data: [
            {
              providerId,
              providerEventId: event.eventId.slice(0, 128),
              eventType: event.eventType.slice(0, 128),
              payload: sanitize(event.raw),
              status:
                reason === 'ok' || reason === 'duplicate'
                  ? event.type === 'IGNORED'
                    ? 'IGNORED'
                    : 'PROCESSED'
                  : 'FAILED',
              error:
                error ??
                (reason === 'ok' || reason === 'duplicate' ? null : reason),
            },
          ],
          skipDuplicates: true,
        });
        after.add(
          new ProjectionEvent(PAYMENT_EVENTS.WEBHOOK_RECEIVED, {
            providerId,
            eventType: event.eventType,
            reason,
          }),
        );
      },
    });
    return adapter.ack(reason);
  }

  /** Applies a normalised provider event to its payment. Idempotent (status checked under a row lock). */
  async apply(
    provider: ProviderRow,
    event: ProviderEvent,
    source: string,
  ): Promise<AckReason> {
    if (event.type === 'IGNORED') return 'ok';
    if (!event.providerRef) return 'unknown-payment';
    const p = await this.prisma.payment.findFirst({
      where: { providerId: provider.id, providerRef: event.providerRef },
      select: PAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    if (!p) return 'unknown-payment';
    if (event.type === 'APPROVED') {
      if (p.status !== 'PENDING') return 'duplicate';
      const adapter = this.adapters.for(provider);
      if (!adapter.capture) return 'ok';
      return this.apply(
        provider,
        await adapter.capture(await this.stored(p)),
        source,
      );
    }
    const outcome = await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        event.type.toLowerCase(),
        p.id,
        SYSTEM_ACTOR,
        { source },
      ),
      work: async (
        tx,
        after,
      ): Promise<{ reason: AckReason; refund?: string }> => {
        const [locked] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM payments WHERE id = ${p.id}::uuid FOR UPDATE`;
        if (event.type === 'CAPTURED') {
          if (locked.status === 'CAPTURED') return { reason: 'duplicate' };
          if (event.amount != null && event.amount !== p.amount) {
            await tx.paymentTransaction.create({
              data: {
                paymentId: p.id,
                type: 'FAILURE',
                amount: event.amount,
                succeeded: false,
                providerRef: event.captureRef ?? null,
                source,
                raw: sanitize(event.raw),
              },
            });
            this.logger.error(
              `Payment ${p.id}: provider reports ${event.amount}, expected ${p.amount}; not captured`,
            );
            return { reason: 'amount-mismatch' };
          }
          await tx.payment.update({
            where: { id: p.id },
            data: {
              status: 'CAPTURED',
              captureRef: event.captureRef ?? p.providerRef,
              capturedAt: new Date(),
              failureReason: null,
            },
          });
          await tx.paymentTransaction.create({
            data: {
              paymentId: p.id,
              type: 'CAPTURE',
              amount: p.amount,
              succeeded: true,
              providerRef: event.captureRef ?? null,
              source,
              raw: sanitize(event.raw),
            },
          });
          const total = await tx.payment.aggregate({
            where: { orderId: p.orderId, status: 'CAPTURED' },
            _sum: { amount: true },
          });
          const totalCaptured = total._sum.amount ?? 0n;
          this.emit(after, PAYMENT_EVENTS.CAPTURED, p, {
            totalCaptured: totalCaptured.toString(),
          });
          // Money arrived for an attempt the shop no longer wanted (cancelled order or paid twice).
          const o = await this.orders.paymentFacts(p.orderId);
          const unwanted =
            ['CANCELED', 'CLOSED'].includes(o.status) ||
            totalCaptured - p.amount >= o.amountDue;
          return {
            reason: 'ok',
            refund: unwanted
              ? o.status === 'CANCELED'
                ? 'The order was cancelled before the payment completed'
                : 'The order was already paid'
              : undefined,
          };
        }
        if (locked.status !== 'PENDING') return { reason: 'duplicate' };
        await this.markFailed(
          tx,
          after,
          p,
          event.type === 'CANCELED' ? 'CANCELED' : 'FAILED',
          event.reason ?? event.type.toLowerCase(),
          source,
          event.raw,
        );
        return { reason: 'ok' };
      },
    });
    if (outcome.refund)
      await this.refunds.autoRefund(p.id, outcome.refund, SYSTEM_ACTOR);
    return outcome.reason;
  }

  /** Cash on delivery collected (staff). */
  async captureCod(
    paymentId: string,
    actor: ActorRef,
  ): Promise<AdminPaymentDto> {
    const p = await this.load(paymentId);
    if (p.status !== 'AWAITING_COLLECTION')
      throw new ConflictException(
        'Only cash-on-delivery payments waiting for collection can be captured',
      );
    await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'capture',
        p.id,
        actor,
      ),
      work: async (tx, after) => {
        const { count } = await tx.payment.updateMany({
          where: { id: p.id, status: 'AWAITING_COLLECTION' },
          data: {
            status: 'CAPTURED',
            capturedAt: new Date(),
            captureRef: `cod-${p.id}`,
          },
        });
        if (!count) return;
        await tx.paymentTransaction.create({
          data: {
            paymentId: p.id,
            type: 'CAPTURE',
            amount: p.amount,
            succeeded: true,
            source: 'admin',
            raw: { by: actor.label },
          },
        });
        const total = await tx.payment.aggregate({
          where: { orderId: p.orderId, status: 'CAPTURED' },
          _sum: { amount: true },
        });
        this.emit(
          after,
          PAYMENT_EVENTS.CAPTURED,
          p,
          { totalCaptured: (total._sum.amount ?? 0n).toString() },
          actor,
        );
      },
    });
    return this.adminView(await this.load(paymentId));
  }

  /** The order was cancelled: open attempts are cancelled (best effort at the provider too). */
  async cancelOpen(orderId: string): Promise<void> {
    const open = await this.prisma.payment.findMany({
      where: { orderId, status: { in: ['PENDING', 'AWAITING_COLLECTION'] } },
      select: PAYMENT_SELECT,
    });
    for (const p of open)
      await this.cancelPayment(p, 'The order was cancelled');
  }

  private async cancelPayment(p: PaymentRow, reason: string): Promise<void> {
    await this.adapters
      .for(p.provider)
      .cancel?.(await this.stored(p))
      .catch((e: Error) =>
        this.logger.warn(
          `Could not cancel payment ${p.id} at ${p.providerCode}: ${e.message}`,
        ),
      );
    await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'cancel',
        p.id,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        const [locked] = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM payments WHERE id = ${p.id}::uuid FOR UPDATE`;
        if (!['PENDING', 'AWAITING_COLLECTION'].includes(locked.status)) return;
        await this.markFailed(tx, after, p, 'CANCELED', reason, 'api', null);
      },
    });
  }

  private async fail(
    paymentId: string,
    reason: string,
    source: string,
  ): Promise<void> {
    const p = await this.load(paymentId);
    await this.bus.write({
      before: new BeforeWriteEvent(
        PAYMENT_EVENTS.BEFORE_WRITE,
        'fail',
        paymentId,
        SYSTEM_ACTOR,
      ),
      work: (tx, after) =>
        this.markFailed(tx, after, p, 'FAILED', reason, source, null),
    });
  }

  private async markFailed(
    tx: PrismaTransaction,
    after: AfterEvents,
    p: PaymentRow,
    status: 'FAILED' | 'CANCELED',
    reason: string,
    source: string,
    raw: unknown,
  ): Promise<void> {
    await tx.payment.update({
      where: { id: p.id },
      data: { status, failureReason: reason.slice(0, 500) },
    });
    await tx.paymentTransaction.create({
      data: {
        paymentId: p.id,
        type: status === 'FAILED' ? 'FAILURE' : 'VOID',
        amount: p.amount,
        succeeded: status === 'CANCELED',
        source,
        raw: sanitize(raw),
      },
    });
    this.emit(
      after,
      status === 'FAILED' ? PAYMENT_EVENTS.FAILED : PAYMENT_EVENTS.CANCELED,
      p,
      {},
    );
  }

  /**
   * Job: asks providers about payments still pending after a while (missed webhooks), then about
   * refunds they answered as pending (`refundsMinAgeMs`: how old those must be; 0 = all of them).
   */
  async reconcile(
    now = new Date(),
    refundsMinAgeMs?: number,
  ): Promise<{
    checked: number;
    changed: number;
    refunds: { checked: number; settled: number };
  }> {
    const pending = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        providerCode: { not: 'COD' },
        providerRef: { not: null },
        createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
      },
      select: PAYMENT_SELECT,
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    let changed = 0;
    for (const p of pending)
      try {
        const event = await this.adapters
          .for(p.provider)
          .status(await this.stored(p));
        if (event.type === 'IGNORED') continue;
        if ((await this.apply(p.provider, event, 'reconciliation')) === 'ok')
          changed++;
      } catch (e) {
        this.logger.warn(
          `Reconciling payment ${p.id} failed: ${(e as Error).message}`,
        );
      }
    return {
      checked: pending.length,
      changed,
      refunds: await this.refunds.settlePending(now, refundsMinAgeMs),
    };
  }

  async forOrder(orderId: string): Promise<OrderPaymentsDto> {
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: { orderId },
        select: PAYMENT_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.refund.findMany({
        where: { orderId },
        select: REFUND_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const views = await Promise.all(payments.map((p) => this.adminView(p)));
    const fmt = await this.formatter();
    return {
      payments: views,
      refunds: refunds.map((r) => ({
        id: r.id,
        paymentId: r.paymentId,
        amount: {
          amount: Number(r.amount),
          formatted: fmt(r.amount, r.currencyCode),
        },
        status: r.status,
        reason: r.reason,
        providerRef: r.providerRef,
        failureReason: r.failureReason,
        restock: r.restock,
        createdAt: r.createdAt,
      })),
    };
  }

  // ─── internals ───

  private emit(
    after: AfterEvents,
    name: string,
    p: PaymentRow,
    extra: Partial<PaymentEventData>,
    actor: ActorRef = SYSTEM_ACTOR,
  ): void {
    after.add(
      new EntityEvent<PaymentEventData>(
        name,
        actor,
        'payment',
        p.id,
        { provider: p.providerCode, amount: p.amount.toString() },
        {
          paymentId: p.id,
          orderId: p.orderId,
          provider: p.providerCode,
          amount: p.amount.toString(),
          ...extra,
        },
      ),
    );
  }

  private async load(paymentId: string): Promise<PaymentRow> {
    const p = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: PAYMENT_SELECT,
    });
    if (!p) throw new NotFoundException(`Payment ${paymentId} not found`);
    return p;
  }

  private async stored(p: PaymentRow): Promise<StoredPayment> {
    return {
      id: p.id,
      providerRef: p.providerRef,
      captureRef: p.captureRef,
      amount: p.amount,
      currencyCode: p.currencyCode,
      minorUnits: await this.minorUnits(p.currencyCode),
      createdAt: p.createdAt,
      capturedAt: p.capturedAt,
    };
  }

  private async formatter() {
    const snap = await this.stores.snapshot();
    return (amount: bigint, currency: string) =>
      formatMoney(
        amount,
        currency,
        snap.currencies.get(currency)?.minorUnits ?? 2,
        'en-US',
      );
  }

  async view(p: PaymentRow): Promise<PaymentDto> {
    const fmt = await this.formatter();
    return {
      id: p.id,
      status: p.status,
      provider: p.providerCode,
      method: p.method?.code ?? null,
      amount: {
        amount: Number(p.amount),
        formatted: fmt(p.amount, p.currencyCode),
      },
      action:
        p.status === 'PENDING'
          ? ((p.action as PaymentDto['action']) ?? null)
          : null,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
    };
  }

  private async adminView(p: PaymentRow): Promise<AdminPaymentDto> {
    const fmt = await this.formatter();
    const txs = await this.prisma.paymentTransaction.findMany({
      where: { paymentId: p.id },
      orderBy: { createdAt: 'asc' },
      select: {
        type: true,
        amount: true,
        succeeded: true,
        providerRef: true,
        source: true,
        createdAt: true,
      },
    });
    return {
      ...(await this.view(p)),
      providerRef: p.providerRef,
      captureRef: p.captureRef,
      amountRefunded: {
        amount: Number(p.amountRefunded),
        formatted: fmt(p.amountRefunded, p.currencyCode),
      },
      capturedAt: p.capturedAt,
      transactions: txs.map((t) => ({
        ...t,
        amount: {
          amount: Number(t.amount),
          formatted: fmt(t.amount, p.currencyCode),
        },
      })),
    };
  }

  /** For tests and the admin "check now" button. */
  adapterFor(row: ProviderRow): PaymentAdapter {
    return this.adapters.for(row);
  }
}
