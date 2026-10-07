import type { PaymentProviderCode } from '../../../database/generated/prisma/client.js';

/** What the shopper must do next (never contains secrets). */
export type PaymentAction =
  | { type: 'REDIRECT'; url: string; deeplink?: string; qrCodeUrl?: string }
  | { type: 'CLIENT_SECRET'; clientSecret: string; publishableKey: string }
  | { type: 'NONE' };

export interface PaymentRequest {
  paymentId: string;
  amount: bigint;
  currencyCode: string;
  /** Minor units of the currency (PayPal sends decimal strings). */
  minorUnits: number;
  orderId: string;
  orderNumber: string;
  email: string;
  localeCode: string;
  returnUrl: string;
  cancelUrl: string;
  /** Where the provider posts notifications for this payment. */
  notifyUrl: string;
  clientIp: string;
  createdAt: Date;
}

export interface CreatedPayment {
  providerRef: string | null;
  action: PaymentAction;
  /** COD is accepted at once; others wait for the shopper. */
  accepted?: boolean;
  raw: unknown;
}

/** A verified notification, return or status result, normalised. */
export interface ProviderEvent {
  /** Unique per notification (webhook de-duplication). */
  eventId: string;
  type: 'CAPTURED' | 'FAILED' | 'CANCELED' | 'APPROVED' | 'IGNORED';
  eventType: string;
  providerRef: string | null;
  captureRef?: string | null;
  amount?: bigint | null;
  reason?: string;
  raw: unknown;
}

export interface StoredPayment {
  id: string;
  providerRef: string | null;
  captureRef: string | null;
  amount: bigint;
  currencyCode: string;
  minorUnits: number;
  createdAt: Date;
  capturedAt: Date | null;
}

export interface RefundResult {
  providerRef: string | null;
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  reason?: string;
  raw: unknown;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  query: Record<string, string>;
}

/** How a provider wants a notification acknowledged. */
export interface WebhookAck {
  status: number;
  body?: unknown;
}

export type AckReason =
  | 'ok'
  | 'duplicate'
  | 'invalid-signature'
  | 'unknown-payment'
  | 'amount-mismatch'
  | 'error';

/**
 * A payment provider adapter (PLAN.md §9.6). Adapters speak the provider's own protocol (REST,
 * signed redirects, signed notifications) and normalise it; they never store card data.
 */
export interface PaymentAdapter {
  readonly code: PaymentProviderCode;
  createPayment(req: PaymentRequest): Promise<CreatedPayment>;
  /** Verifies a notification (throws InvalidSignatureError) and normalises it. */
  parseWebhook(req: WebhookRequest): Promise<ProviderEvent>;
  /** The shopper came back from the provider: verify (and capture, where that's the protocol). */
  handleReturn(
    payment: StoredPayment,
    params: Record<string, string>,
  ): Promise<ProviderEvent>;
  /** Completes an approved payment (PayPal). */
  capture?(payment: StoredPayment): Promise<ProviderEvent>;
  refund(
    payment: StoredPayment,
    amount: bigint,
    refundId: string,
    reason: string,
  ): Promise<RefundResult>;
  /** The provider's view of a payment (reconciliation). */
  status(payment: StoredPayment): Promise<ProviderEvent>;
  /** The provider's view of a refund it answered as pending (reconciliation). */
  refundStatus?(
    payment: StoredPayment,
    refund: { id: string; providerRef: string | null },
  ): Promise<RefundResult>;
  cancel?(payment: StoredPayment): Promise<void>;
  ack(reason: AckReason): WebhookAck;
}

export class InvalidSignatureError extends Error {
  constructor(message = 'Invalid signature') {
    super(message);
  }
}

export class ProviderError extends Error {}

/** `12345` minor units with 2 decimals → `"123.45"`. */
export function toDecimal(amount: bigint, minorUnits: number): string {
  if (minorUnits === 0) return amount.toString();
  const s = amount.toString().padStart(minorUnits + 1, '0');
  return `${s.slice(0, -minorUnits)}.${s.slice(-minorUnits)}`;
}

/** `"123.45"` → `12345n` (2 decimals). */
export function fromDecimal(value: string, minorUnits: number): bigint {
  const [i, f = ''] = value.split('.');
  return BigInt(i + f.padEnd(minorUnits, '0').slice(0, minorUnits));
}

export const header = (
  h: WebhookRequest['headers'],
  name: string,
): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
