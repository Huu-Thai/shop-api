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

export interface VnpayCredentials {
  tmnCode: string;
  hashSecret: string;
  payUrl?: string;
  apiUrl?: string;
}

/** VNPay timestamps are Vietnam time, `yyyyMMddHHmmss`. */
export function vnpDate(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

/** VNPay's canonical query: keys sorted, values URL-encoded with spaces as `+`. */
export function vnpQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`,
    )
    .join('&');
}

const hmac512 = (secret: string, data: string) =>
  createHmac('sha512', secret).update(data, 'utf8').digest('hex');

/** The merchant reference of a payment (VNPay limits vnp_TxnRef to alphanumerics). */
export const txnRef = (paymentId: string) => paymentId.replace(/-/g, '');

/**
 * VNPay 2.1.0: a signed redirect to the VNPay gateway (HMAC-SHA512 over the sorted query); the
 * result comes back on the return URL and the IPN, both signed the same way. Refunds and status
 * queries use the merchant API with pipe-joined checksums. VND only.
 */
export class VnpayProvider implements PaymentAdapter {
  readonly code = 'VNPAY' as const;
  private readonly payUrl: string;
  private readonly apiUrl: string;

  constructor(
    private readonly c: VnpayCredentials,
    sandbox: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const host = sandbox
      ? 'https://sandbox.vnpayment.vn'
      : 'https://pay.vnpay.vn';
    this.payUrl = c.payUrl ?? `${host}/paymentv2/vpcpay.html`;
    this.apiUrl =
      c.apiUrl ??
      `${sandbox ? 'https://sandbox.vnpayment.vn' : 'https://merchant.vnpay.vn'}/merchant_webapi/api/transaction`;
  }

  async createPayment(r: PaymentRequest): Promise<CreatedPayment> {
    if (r.currencyCode !== 'VND')
      throw new ProviderError('VNPay accepts VND only');
    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.c.tmnCode,
      vnp_Amount: (r.amount * 100n).toString(),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: txnRef(r.paymentId),
      vnp_OrderInfo: `Thanh toan don hang ${r.orderNumber}`,
      vnp_OrderType: 'other',
      vnp_Locale: r.localeCode.startsWith('vi') ? 'vn' : 'en',
      vnp_ReturnUrl: r.returnUrl,
      vnp_IpAddr: r.clientIp,
      vnp_CreateDate: vnpDate(r.createdAt),
      vnp_ExpireDate: vnpDate(new Date(r.createdAt.getTime() + 15 * 60_000)),
    };
    const query = vnpQuery(params);
    return {
      providerRef: params.vnp_TxnRef,
      action: {
        type: 'REDIRECT',
        url: `${this.payUrl}?${query}&vnp_SecureHash=${hmac512(this.c.hashSecret, query)}`,
      },
      raw: {
        vnp_TxnRef: params.vnp_TxnRef,
        vnp_CreateDate: params.vnp_CreateDate,
      },
    };
  }

  /** Verifies the vnp_* parameters of a return or IPN. */
  verify(query: Record<string, string>): void {
    const { vnp_SecureHash: hash, vnp_SecureHashType: _t, ...rest } = query;
    const signed = Object.fromEntries(
      Object.entries(rest).filter(([k]) => k.startsWith('vnp_')),
    );
    const expected = hmac512(this.c.hashSecret, vnpQuery(signed));
    if (
      !hash ||
      hash.length !== expected.length ||
      !timingSafeEqual(Buffer.from(hash.toLowerCase()), Buffer.from(expected))
    )
      throw new InvalidSignatureError();
  }

  private event(q: Record<string, string>, source: string): ProviderEvent {
    const ok =
      q.vnp_ResponseCode === '00' && (q.vnp_TransactionStatus ?? '00') === '00';
    return {
      eventId: `${source}:${q.vnp_TxnRef}:${q.vnp_TransactionNo ?? ''}:${q.vnp_ResponseCode}`,
      eventType: `vnpay.${source}.${q.vnp_ResponseCode}`,
      type: ok ? 'CAPTURED' : 'FAILED',
      providerRef: q.vnp_TxnRef ?? null,
      captureRef: q.vnp_TransactionNo ?? null,
      amount: q.vnp_Amount ? BigInt(q.vnp_Amount) / 100n : null,
      reason: ok ? undefined : `VNPay response ${q.vnp_ResponseCode}`,
      raw: q,
    };
  }

  async parseWebhook(req: WebhookRequest): Promise<ProviderEvent> {
    this.verify(req.query);
    return this.event(req.query, 'ipn');
  }

  async handleReturn(
    _p: StoredPayment,
    params: Record<string, string>,
  ): Promise<ProviderEvent> {
    this.verify(params);
    return this.event(params, 'return');
  }

  private async api<T>(
    fields: Record<string, string>,
    signed: string[],
  ): Promise<T> {
    const vnp_SecureHash = hmac512(
      this.c.hashSecret,
      signed.map((k) => fields[k]).join('|'),
    );
    const { body } = await providerRequest<T>(this.fetchImpl, this.apiUrl, {
      json: { ...fields, vnp_SecureHash },
    });
    return body;
  }

  async refund(
    p: StoredPayment,
    amount: bigint,
    refundId: string,
    reason: string,
  ): Promise<RefundResult> {
    const fields: Record<string, string> = {
      vnp_RequestId: refundId.replace(/-/g, '').slice(0, 32),
      vnp_Version: '2.1.0',
      vnp_Command: 'refund',
      vnp_TmnCode: this.c.tmnCode,
      vnp_TransactionType: amount === p.amount ? '02' : '03',
      vnp_TxnRef: p.providerRef!,
      vnp_Amount: (amount * 100n).toString(),
      vnp_TransactionNo: p.captureRef ?? '',
      vnp_TransactionDate: vnpDate(p.createdAt),
      vnp_CreateBy: 'shop',
      vnp_CreateDate: vnpDate(new Date()),
      vnp_IpAddr: '127.0.0.1',
      vnp_OrderInfo: reason.slice(0, 255) || 'Refund',
    };
    const body = await this.api<{
      vnp_ResponseCode: string;
      vnp_TransactionNo?: string;
      vnp_Message?: string;
    }>(fields, [
      'vnp_RequestId',
      'vnp_Version',
      'vnp_Command',
      'vnp_TmnCode',
      'vnp_TransactionType',
      'vnp_TxnRef',
      'vnp_Amount',
      'vnp_TransactionNo',
      'vnp_TransactionDate',
      'vnp_CreateBy',
      'vnp_CreateDate',
      'vnp_IpAddr',
      'vnp_OrderInfo',
    ]);
    return {
      providerRef: body.vnp_TransactionNo ?? null,
      status: body.vnp_ResponseCode === '00' ? 'SUCCEEDED' : 'FAILED',
      reason:
        body.vnp_ResponseCode === '00'
          ? undefined
          : `VNPay response ${body.vnp_ResponseCode}: ${body.vnp_Message ?? ''}`,
      raw: body,
    };
  }

  async status(p: StoredPayment): Promise<ProviderEvent> {
    const fields: Record<string, string> = {
      vnp_RequestId: randomUUID().replace(/-/g, ''),
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: this.c.tmnCode,
      vnp_TxnRef: p.providerRef!,
      vnp_OrderInfo: 'Query',
      vnp_TransactionDate: vnpDate(p.createdAt),
      vnp_CreateDate: vnpDate(new Date()),
      vnp_IpAddr: '127.0.0.1',
    };
    const body = await this.api<Record<string, string>>(fields, [
      'vnp_RequestId',
      'vnp_Version',
      'vnp_Command',
      'vnp_TmnCode',
      'vnp_TxnRef',
      'vnp_TransactionDate',
      'vnp_CreateDate',
      'vnp_IpAddr',
      'vnp_OrderInfo',
    ]);
    if (body.vnp_ResponseCode !== '00')
      return {
        eventId: `status:${p.providerRef}`,
        eventType: 'vnpay.status.unknown',
        type: 'IGNORED',
        providerRef: p.providerRef,
        raw: body,
      };
    return this.event(
      {
        ...body,
        vnp_TxnRef: p.providerRef!,
        vnp_ResponseCode:
          body.vnp_TransactionStatus === '00'
            ? '00'
            : body.vnp_TransactionStatus,
      },
      'status',
    );
  }

  /** VNPay reads the IPN answer from the JSON body (always HTTP 200). */
  ack(reason: AckReason): WebhookAck {
    const codes: Record<AckReason, [string, string]> = {
      ok: ['00', 'Confirm Success'],
      duplicate: ['02', 'Order already confirmed'],
      'invalid-signature': ['97', 'Invalid signature'],
      'unknown-payment': ['01', 'Order not found'],
      'amount-mismatch': ['04', 'Invalid amount'],
      error: ['99', 'Unknown error'],
    };
    const [RspCode, Message] = codes[reason];
    return { status: 200, body: { RspCode, Message } };
  }
}
