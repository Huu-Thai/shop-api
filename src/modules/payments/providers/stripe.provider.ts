import { createHmac, timingSafeEqual } from 'node:crypto';
import { providerRequest } from './http.js';
import {
  type AckReason,
  type CreatedPayment,
  header,
  InvalidSignatureError,
  type PaymentAdapter,
  type PaymentRequest,
  type ProviderEvent,
  type RefundResult,
  type StoredPayment,
  type WebhookAck,
  type WebhookRequest,
} from './types.js';

export interface StripeCredentials {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiBase?: string;
}

interface Intent {
  id: string;
  status: string;
  client_secret?: string;
  amount: number;
  amount_received?: number;
  latest_charge?: string | null;
  last_payment_error?: { message?: string } | null;
}

/** Signature tolerance (Stripe's default). */
const TOLERANCE_S = 300;

/**
 * Stripe Payment Intents: the storefront confirms with Stripe.js (client secret); success arrives as
 * a signed `payment_intent.succeeded` webhook (HMAC-SHA256 over `t.payload`).
 */
export class StripeProvider implements PaymentAdapter {
  readonly code = 'STRIPE' as const;
  private readonly base: string;

  constructor(
    private readonly c: StripeCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.base = (c.apiBase ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  private call<T>(
    path: string,
    form?: Record<string, string>,
    idempotencyKey?: string,
  ) {
    return providerRequest<T>(this.fetchImpl, `${this.base}${path}`, {
      method: form ? 'POST' : 'GET',
      form,
      headers: {
        authorization: `Bearer ${this.c.secretKey}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });
  }

  async createPayment(r: PaymentRequest): Promise<CreatedPayment> {
    const { body } = await this.call<Intent>(
      '/v1/payment_intents',
      {
        amount: r.amount.toString(),
        currency: r.currencyCode.toLowerCase(),
        'automatic_payment_methods[enabled]': 'true',
        description: `Order ${r.orderNumber}`,
        receipt_email: r.email,
        'metadata[order_id]': r.orderId,
        'metadata[payment_id]': r.paymentId,
      },
      `payment-${r.paymentId}`,
    );
    return {
      providerRef: body.id,
      action: {
        type: 'CLIENT_SECRET',
        clientSecret: body.client_secret!,
        publishableKey: this.c.publishableKey,
      },
      raw: { id: body.id, status: body.status },
    };
  }

  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent> {
    const sig = header(req.headers, 'stripe-signature') ?? '';
    const parts = Object.fromEntries(
      sig.split(',').map((kv) => kv.split('=') as [string, string]),
    );
    const t = Number(parts.t);
    const expected = createHmac('sha256', this.c.webhookSecret)
      .update(`${parts.t}.${req.rawBody.toString('utf8')}`)
      .digest('hex');
    const v1 = sig
      .split(',')
      .filter((kv) => kv.startsWith('v1='))
      .map((kv) => kv.slice(3));
    if (
      !t ||
      Math.abs(this.now() / 1000 - t) > TOLERANCE_S ||
      !v1.some(
        (s) =>
          s.length === expected.length &&
          timingSafeEqual(Buffer.from(s), Buffer.from(expected)),
      )
    )
      throw new InvalidSignatureError();
    const event = JSON.parse(req.rawBody.toString('utf8')) as {
      id: string;
      type: string;
      data: { object: Intent };
    };
    return this.normalise(event.id, event.type, event.data.object, event);
  }

  private normalise(
    eventId: string,
    type: string,
    o: Intent,
    raw: unknown,
  ): ProviderEvent {
    const base = { eventId, eventType: type, providerRef: o.id, raw };
    if (type === 'payment_intent.succeeded' || o.status === 'succeeded')
      return {
        ...base,
        type: 'CAPTURED',
        captureRef: o.latest_charge ?? o.id,
        amount: BigInt(o.amount_received ?? o.amount),
      };
    if (type === 'payment_intent.payment_failed')
      return {
        ...base,
        type: 'FAILED',
        reason: o.last_payment_error?.message ?? 'Payment failed',
      };
    if (type === 'payment_intent.canceled' || o.status === 'canceled')
      return { ...base, type: 'CANCELED' };
    return { ...base, type: 'IGNORED' };
  }

  /** Stripe.js confirms in the browser; the return just re-reads the intent. */
  handleReturn(payment: StoredPayment): Promise<ProviderEvent> {
    return this.status(payment);
  }

  async status(p: StoredPayment): Promise<ProviderEvent> {
    const { body } = await this.call<Intent>(
      `/v1/payment_intents/${p.providerRef}`,
    );
    return this.normalise(
      `status:${body.id}:${body.status}`,
      `status.${body.status}`,
      body,
      body,
    );
  }

  async refund(
    p: StoredPayment,
    amount: bigint,
    refundId: string,
  ): Promise<RefundResult> {
    const { body } = await this.call<StripeRefund>(
      '/v1/refunds',
      {
        payment_intent: p.providerRef!,
        amount: amount.toString(),
        'metadata[refund_id]': refundId,
      },
      `refund-${refundId}`,
    );
    return stripeRefund(body);
  }

  async refundStatus(
    _p: StoredPayment,
    refund: { providerRef: string | null },
  ): Promise<RefundResult> {
    const { body } = await this.call<StripeRefund>(
      `/v1/refunds/${refund.providerRef}`,
    );
    return stripeRefund(body);
  }

  async cancel(p: StoredPayment): Promise<void> {
    if (p.providerRef)
      await this.call(`/v1/payment_intents/${p.providerRef}/cancel`, {});
  }

  ack(reason: AckReason): WebhookAck {
    return reason === 'invalid-signature'
      ? { status: 400 }
      : { status: 200, body: { received: true } };
  }
}

interface StripeRefund {
  id: string;
  status: string;
  failure_reason?: string;
}

const stripeRefund = (body: StripeRefund): RefundResult => ({
  providerRef: body.id,
  status:
    body.status === 'succeeded'
      ? 'SUCCEEDED'
      : body.status === 'failed' || body.status === 'canceled'
        ? 'FAILED'
        : 'PENDING',
  reason: body.failure_reason,
  raw: body,
});
