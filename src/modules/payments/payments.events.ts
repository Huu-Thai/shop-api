import { entityEvents } from '../../common/events/entity.events.js';

export const PAYMENT_EVENTS = {
  ...entityEvents('payment'),
  /** Money arrived. `totalCaptured` is the order's total over all its captured payments. */
  CAPTURED: 'payment.captured',
  /** Cash on delivery accepted (nothing paid yet). */
  ACCEPTED: 'payment.accepted',
  FAILED: 'payment.failed',
  CANCELED: 'payment.canceled',
  REFUNDED: 'payment.refunded',
  REFUND_FAILED: 'payment.refund-failed',
  WEBHOOK_RECEIVED: 'payment.webhook-received',
} as const;

export interface PaymentEventData {
  paymentId: string;
  orderId: string;
  provider: string;
  amount: string;
  /** Sum of the order's captured payments (orders set amount_paid from it — idempotent). */
  totalCaptured?: string;
}

export interface PaymentRefundedData extends PaymentEventData {
  refundId: string;
  /** Sum of the order's succeeded refunds. */
  totalRefunded: string;
  /** Sum of the order's captured payments (the refund may be handled before the capture). */
  totalCaptured: string;
  items: { orderItemId: string; quantity: number }[];
  restock: boolean;
}
