import { providerRequest } from './http.js';
import {
  type AckReason,
  type CreatedPayment,
  fromDecimal,
  header,
  InvalidSignatureError,
  type PaymentAdapter,
  type PaymentRequest,
  type ProviderEvent,
  ProviderError,
  type RefundResult,
  type StoredPayment,
  toDecimal,
  type WebhookAck,
  type WebhookRequest,
} from './types.js';

/** PayPal's currencies without decimals. */
const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  apiBase?: string;
}

interface PayPalOrder {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    payments?: {
      captures?: { id: string; status: string; amount: { value: string } }[];
    };
  }[];
}

/**
 * PayPal Orders v2: create an order → the shopper approves on PayPal → we capture on return (or on
 * the CHECKOUT.ORDER.APPROVED webhook). Webhooks are verified with PayPal's verification API.
 */
export class PayPalProvider implements PaymentAdapter {
  readonly code = 'PAYPAL' as const;
  private readonly base: string;
  private token?: { value: string; until: number };

  constructor(
    private readonly c: PayPalCredentials,
    sandbox: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = (
      c.apiBase ??
      (sandbox
        ? 'https://api-m.sandbox.paypal.com'
        : 'https://api-m.paypal.com')
    ).replace(/\/+$/, '');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const { body } = await providerRequest<{
      access_token: string;
      expires_in: number;
    }>(this.fetchImpl, `${this.base}/v1/oauth2/token`, {
      form: { grant_type: 'client_credentials' },
      headers: {
        authorization: `Basic ${Buffer.from(`${this.c.clientId}:${this.c.clientSecret}`).toString('base64')}`,
      },
    });
    this.token = {
      value: body.access_token,
      until: Date.now() + (body.expires_in - 60) * 1000,
    };
    return body.access_token;
  }

  private async call<T>(
    path: string,
    json?: unknown,
    requestId?: string,
    ok?: number[],
  ) {
    return providerRequest<T>(this.fetchImpl, `${this.base}${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      json,
      ok,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
      },
    });
  }

  async createPayment(r: PaymentRequest): Promise<CreatedPayment> {
    const { body } = await this.call<PayPalOrder>(
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: r.paymentId,
            custom_id: r.orderId,
            invoice_id: `${r.orderNumber}-${r.paymentId.slice(0, 8)}`,
            amount: {
              currency_code: r.currencyCode,
              value: toDecimal(r.amount, r.minorUnits),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: r.returnUrl,
              cancel_url: r.cancelUrl,
              user_action: 'PAY_NOW',
              locale: r.localeCode,
            },
          },
        },
      },
      `payment-${r.paymentId}`,
    );
    const approve = body.links?.find(
      (l) => l.rel === 'payer-action' || l.rel === 'approve',
    );
    if (!approve) throw new ProviderError('PayPal returned no approval link');
    return {
      providerRef: body.id,
      action: { type: 'REDIRECT', url: approve.href },
      raw: { id: body.id, status: body.status },
    };
  }

  private captured(
    eventId: string,
    eventType: string,
    order: PayPalOrder,
    minorUnits: number,
  ): ProviderEvent {
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    const base = { eventId, eventType, providerRef: order.id, raw: order };
    if (order.status === 'COMPLETED' && cap?.status === 'COMPLETED')
      return {
        ...base,
        type: 'CAPTURED',
        captureRef: cap.id,
        amount: fromDecimal(cap.amount.value, minorUnits),
      };
    if (order.status === 'APPROVED') return { ...base, type: 'APPROVED' };
    if (order.status === 'VOIDED') return { ...base, type: 'CANCELED' };
    if (cap && ['DECLINED', 'FAILED'].includes(cap.status))
      return {
        ...base,
        type: 'FAILED',
        reason: `Capture ${cap.status.toLowerCase()}`,
      };
    return { ...base, type: 'IGNORED' };
  }

  async capture(p: StoredPayment): Promise<ProviderEvent> {
    const { status, body } = await this.call<
      PayPalOrder & { details?: { issue: string }[] }
    >(
      `/v2/checkout/orders/${p.providerRef}/capture`,
      {},
      `capture-${p.id}`,
      [422],
    );
    if (status === 422) {
      if (body.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED'))
        return this.status(p);
      return {
        eventId: `capture:${p.providerRef}`,
        eventType: 'capture.failed',
        type: 'FAILED',
        providerRef: p.providerRef,
        reason: body.details?.[0]?.issue ?? 'Capture refused',
        raw: body,
      };
    }
    return this.captured(
      `capture:${p.providerRef}`,
      'capture',
      body,
      p.minorUnits,
    );
  }

  /** PayPal sends the shopper back with `token` = the PayPal order id: capture it. */
  async handleReturn(
    p: StoredPayment,
    params: Record<string, string>,
  ): Promise<ProviderEvent> {
    if (params.token && params.token !== p.providerRef)
      throw new InvalidSignatureError('The return does not match this payment');
    return this.capture(p);
  }

  async status(p: StoredPayment): Promise<ProviderEvent> {
    const { body } = await this.call<PayPalOrder>(
      `/v2/checkout/orders/${p.providerRef}`,
    );
    return this.captured(
      `status:${body.id}:${body.status}`,
      `status.${body.status}`,
      body,
      p.minorUnits,
    );
  }

  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent> {
    const event = JSON.parse(req.rawBody.toString('utf8')) as {
      id: string;
      event_type: string;
      resource: {
        id: string;
        status?: string;
        amount?: { value: string; currency_code: string };
        supplementary_data?: { related_ids?: { order_id?: string } };
      };
    };
    const { body } = await this.call<{ verification_status: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        auth_algo: header(req.headers, 'paypal-auth-algo'),
        cert_url: header(req.headers, 'paypal-cert-url'),
        transmission_id: header(req.headers, 'paypal-transmission-id'),
        transmission_sig: header(req.headers, 'paypal-transmission-sig'),
        transmission_time: header(req.headers, 'paypal-transmission-time'),
        webhook_id: this.c.webhookId,
        webhook_event: event,
      },
    );
    if (body.verification_status !== 'SUCCESS')
      throw new InvalidSignatureError();
    const r = event.resource;
    const base = { eventId: event.id, eventType: event.event_type, raw: event };
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        return { ...base, type: 'APPROVED', providerRef: r.id };
      case 'PAYMENT.CAPTURE.COMPLETED':
        return {
          ...base,
          type: 'CAPTURED',
          providerRef: r.supplementary_data?.related_ids?.order_id ?? null,
          captureRef: r.id,
          amount: r.amount
            ? fromDecimal(
                r.amount.value,
                ZERO_DECIMAL.has(r.amount.currency_code) ? 0 : 2,
              )
            : null,
        };
      case 'PAYMENT.CAPTURE.DENIED':
        return {
          ...base,
          type: 'FAILED',
          providerRef: r.supplementary_data?.related_ids?.order_id ?? null,
          reason: 'Capture denied',
        };
      default:
        return { ...base, type: 'IGNORED', providerRef: null };
    }
  }

  async refund(
    p: StoredPayment,
    amount: bigint,
    refundId: string,
    reason: string,
  ): Promise<RefundResult> {
    const { body } = await this.call<{ id: string; status: string }>(
      `/v2/payments/captures/${p.captureRef}/refund`,
      {
        amount: {
          value: toDecimal(amount, p.minorUnits),
          currency_code: p.currencyCode,
        },
        note_to_payer: reason.slice(0, 255),
      },
      `refund-${refundId}`,
    );
    return paypalRefund(body);
  }

  async refundStatus(
    _p: StoredPayment,
    refund: { providerRef: string | null },
  ): Promise<RefundResult> {
    const { body } = await this.call<{ id: string; status: string }>(
      `/v2/payments/refunds/${refund.providerRef}`,
    );
    return paypalRefund(body);
  }

  ack(reason: AckReason): WebhookAck {
    return reason === 'invalid-signature' ? { status: 400 } : { status: 200 };
  }
}

const paypalRefund = (body: { id: string; status: string }): RefundResult => ({
  providerRef: body.id,
  status:
    body.status === 'COMPLETED'
      ? 'SUCCEEDED'
      : body.status === 'PENDING'
        ? 'PENDING'
        : 'FAILED',
  raw: body,
});
