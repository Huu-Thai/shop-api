import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { providerRequest } from './http.js';
import {
  type AckReason,
  type CreatedPayment,
  InvalidSignatureError,
  type PaymentAdapter,
  type PaymentRequest,
  type ProviderEvent,
  ProviderError,
  type RefundResult,
  type StoredPayment,
  type WebhookAck,
  type WebhookRequest,
} from './types.js';

export interface MomoCredentials {
  partnerCode: string;
  accessKey: string;
  secretKey: string;
  apiBase?: string;
}

/** MoMo signs `key=value&…` in a documented key order with HMAC-SHA256. */
export function momoSignature(
  secret: string,
  fields: Record<string, string | number>,
  keys: string[],
): string {
  return createHmac('sha256', secret)
    .update(keys.map((k) => `${k}=${fields[k] ?? ''}`).join('&'))
    .digest('hex');
}

const IPN_KEYS = [
  'accessKey',
  'amount',
  'extraData',
  'message',
  'orderId',
  'orderInfo',
  'orderType',
  'partnerCode',
  'payType',
  'requestId',
  'responseTime',
  'resultCode',
  'transId',
];

/**
 * MoMo AIO v2 (captureWallet): create → redirect to `payUrl` (app deeplink / QR); the result comes as
 * a signed IPN (and on the redirect). Refund and query are signed API calls. VND only.
 */
export class MomoProvider implements PaymentAdapter {
  readonly code = 'MOMO' as const;
  private readonly base: string;

  constructor(
    private readonly c: MomoCredentials,
    sandbox: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = (
      c.apiBase ??
      (sandbox ? 'https://test-payment.momo.vn' : 'https://payment.momo.vn')
    ).replace(/\/+$/, '');
  }

  private post<T>(
    path: string,
    fields: Record<string, string | number>,
    signed: string[],
  ) {
    const signature = momoSignature(
      this.c.secretKey,
      { ...fields, accessKey: this.c.accessKey },
      signed,
    );
    return providerRequest<T>(this.fetchImpl, `${this.base}${path}`, {
      json: { ...fields, signature },
    });
  }

  async createPayment(r: PaymentRequest): Promise<CreatedPayment> {
    if (r.currencyCode !== 'VND')
      throw new ProviderError('MoMo accepts VND only');
    const fields = {
      partnerCode: this.c.partnerCode,
      requestId: r.paymentId,
      amount: Number(r.amount),
      orderId: r.paymentId,
      orderInfo: `Order ${r.orderNumber}`,
      redirectUrl: r.returnUrl,
      ipnUrl: r.notifyUrl,
      requestType: 'captureWallet',
      extraData: Buffer.from(JSON.stringify({ orderId: r.orderId })).toString(
        'base64',
      ),
      lang: r.localeCode.startsWith('vi') ? 'vi' : 'en',
    };
    const { body } = await this.post<{
      resultCode: number;
      message: string;
      payUrl?: string;
      deeplink?: string;
      qrCodeUrl?: string;
    }>('/v2/gateway/api/create', fields, [
      'accessKey',
      'amount',
      'extraData',
      'ipnUrl',
      'orderId',
      'orderInfo',
      'partnerCode',
      'redirectUrl',
      'requestId',
      'requestType',
    ]);
    if (body.resultCode !== 0 || !body.payUrl)
      throw new ProviderError(`MoMo refused the payment: ${body.message}`);
    return {
      providerRef: fields.orderId,
      action: {
        type: 'REDIRECT',
        url: body.payUrl,
        deeplink: body.deeplink,
        qrCodeUrl: body.qrCodeUrl,
      },
      raw: { resultCode: body.resultCode },
    };
  }

  private verify(fields: Record<string, string | number>): void {
    const expected = momoSignature(
      this.c.secretKey,
      { ...fields, accessKey: this.c.accessKey },
      IPN_KEYS,
    );
    const sig = String(fields.signature ?? '');
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      throw new InvalidSignatureError();
  }

  private event(
    f: Record<string, string | number>,
    source: string,
  ): ProviderEvent {
    const code = Number(f.resultCode);
    const ok = code === 0 || code === 9000;
    return {
      eventId: `${source}:${f.orderId}:${f.transId}:${code}`,
      eventType: `momo.${source}.${code}`,
      type: ok ? 'CAPTURED' : code === 1000 ? 'IGNORED' : 'FAILED',
      providerRef: String(f.orderId),
      captureRef: f.transId !== undefined ? String(f.transId) : null,
      amount: f.amount !== undefined ? BigInt(f.amount) : null,
      reason: ok ? undefined : String(f.message ?? `MoMo result ${code}`),
      raw: f,
    };
  }

  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent> {
    const body = JSON.parse(req.rawBody.toString('utf8')) as Record<
      string,
      string | number
    >;
    this.verify(body);
    return this.event(body, 'ipn');
  }

  async handleReturn(
    _p: StoredPayment,
    params: Record<string, string>,
  ): Promise<ProviderEvent> {
    this.verify(params);
    return this.event(params, 'return');
  }

  async refund(
    p: StoredPayment,
    amount: bigint,
    refundId: string,
    reason: string,
  ): Promise<RefundResult> {
    const { body } = await this.post<{
      resultCode: number;
      message: string;
      transId?: number;
    }>(
      '/v2/gateway/api/refund',
      {
        partnerCode: this.c.partnerCode,
        orderId: refundId,
        requestId: refundId,
        amount: Number(amount),
        transId: p.captureRef ?? '',
        lang: 'en',
        description: reason.slice(0, 255),
      },
      [
        'accessKey',
        'amount',
        'description',
        'orderId',
        'partnerCode',
        'requestId',
        'transId',
      ],
    );
    return {
      providerRef: body.transId !== undefined ? String(body.transId) : null,
      status:
        body.resultCode === 0
          ? 'SUCCEEDED'
          : body.resultCode === 1000
            ? 'PENDING'
            : 'FAILED',
      reason: body.resultCode === 0 ? undefined : body.message,
      raw: body,
    };
  }

  async status(p: StoredPayment): Promise<ProviderEvent> {
    const requestId = randomUUID();
    const { body } = await this.post<Record<string, string | number>>(
      '/v2/gateway/api/query',
      {
        partnerCode: this.c.partnerCode,
        requestId,
        orderId: p.providerRef!,
        lang: 'en',
      },
      ['accessKey', 'orderId', 'partnerCode', 'requestId'],
    );
    return this.event(body, 'status');
  }

  /** MoMo lists a payment's refunds (by our refund id as their `orderId`). */
  async refundStatus(
    p: StoredPayment,
    refund: { id: string },
  ): Promise<RefundResult> {
    const { body } = await this.post<{
      resultCode: number;
      message: string;
      refundTrans?: { orderId: string; resultCode: number; transId?: number }[];
    }>(
      '/v2/gateway/api/refund/query',
      {
        partnerCode: this.c.partnerCode,
        requestId: randomUUID(),
        orderId: p.providerRef!,
        lang: 'en',
      },
      ['accessKey', 'orderId', 'partnerCode', 'requestId'],
    );
    const t = body.refundTrans?.find((x) => x.orderId === refund.id);
    if (!t)
      return body.resultCode === 0
        ? {
            providerRef: null,
            status: 'FAILED',
            reason: 'MoMo has no such refund',
            raw: body,
          }
        : { providerRef: null, status: 'PENDING', raw: body };
    return {
      providerRef: t.transId !== undefined ? String(t.transId) : null,
      status:
        t.resultCode === 0
          ? 'SUCCEEDED'
          : t.resultCode === 1000
            ? 'PENDING'
            : 'FAILED',
      reason: t.resultCode === 0 ? undefined : body.message,
      raw: body,
    };
  }

  /** MoMo expects 204 No Content for an accepted IPN. */
  ack(reason: AckReason): WebhookAck {
    return reason === 'invalid-signature' ? { status: 400 } : { status: 204 };
  }
}
