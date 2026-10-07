import type {
  AckReason,
  CreatedPayment,
  PaymentAdapter,
  PaymentRequest,
  ProviderEvent,
  RefundResult,
  StoredPayment,
  WebhookAck,
} from './types.js';
import { ProviderError } from './types.js';

/** Cash on delivery: accepted at once, captured by staff when the courier collects the money. */
export class CodProvider implements PaymentAdapter {
  readonly code = 'COD' as const;

  createPayment(_r: PaymentRequest): Promise<CreatedPayment> {
    return Promise.resolve({
      providerRef: null,
      action: { type: 'NONE' },
      accepted: true,
      raw: {},
    });
  }

  parseWebhook(): Promise<ProviderEvent> {
    return Promise.reject(
      new ProviderError('Cash on delivery has no notifications'),
    );
  }

  handleReturn(p: StoredPayment): Promise<ProviderEvent> {
    return this.status(p);
  }

  status(p: StoredPayment): Promise<ProviderEvent> {
    return Promise.resolve({
      eventId: `cod:${p.id}`,
      eventType: 'cod.status',
      type: 'IGNORED',
      providerRef: null,
      raw: {},
    });
  }

  /** The money goes back by hand; the refund is recorded as done. */
  refund(
    _p: StoredPayment,
    _amount: bigint,
    refundId: string,
  ): Promise<RefundResult> {
    return Promise.resolve({
      providerRef: `cod-${refundId}`,
      status: 'SUCCEEDED',
      raw: { manual: true },
    });
  }

  ack(_reason: AckReason): WebhookAck {
    return { status: 404 };
  }
}
