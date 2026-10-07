import { entityEvents } from '../../common/events/entity.events.js';

export const ORDER_EVENTS = {
  ...entityEvents('order'),
  PLACED: 'order.placed',
  /** Cash on delivery accepted: the order is processed before it is paid. */
  ACCEPTED: 'order.accepted',
  PAID: 'order.paid',
  CANCELED: 'order.canceled',
  SHIPPED: 'order.shipped',
  DELIVERED: 'order.delivered',
  REFUNDED: 'order.refunded',
  COMPLETED: 'order.completed',
  NOTE_ADDED: 'order.note-added',
} as const;

/** Data of order events (plain JSON). */
export interface OrderEventData {
  orderId: string;
  number: string;
  storeId: string;
  websiteId: string;
  customerId: string | null;
  cartId?: string | null;
}

export interface OrderRefundedData extends OrderEventData {
  refundId: string;
  amount: string;
  full: boolean;
  restock: { reservationGroupId: string; quantity: number }[];
}
