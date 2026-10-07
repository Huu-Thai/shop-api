import { publishingEvents } from '../../common/content/content-publisher.js';
import { entityEvents } from '../../common/events/entity.events.js';

export const CAMPAIGN_EVENTS = {
  ...entityEvents('campaign'),
  ...publishingEvents('campaign'),
} as const;
export const PROMOTION_EVENTS = {
  ...entityEvents('promotion'),
  ...publishingEvents('promotion'),
  /** Promotions were used by an order (or released when it was cancelled). */
  REDEEMED: 'promotion.redeemed',
  RELEASED: 'promotion.released',
} as const;
export const COUPON_EVENTS = {
  ...entityEvents('coupon'),
  /** A bulk batch finished (or a chunk of it). */
  GENERATED: 'coupon.generated',
} as const;

export interface RedeemedData {
  orderRef: string;
  customerId: string | null;
  promotionIds: string[];
  couponId: string | null;
}
