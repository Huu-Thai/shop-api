import { entityEvents } from '../../common/events/entity.events.js';

export const LOYALTY_PROGRAM_EVENTS = entityEvents('loyalty-program');
export const LOYALTY_TIER_EVENTS = entityEvents('loyalty-tier');
export const LOYALTY_EVENTS = {
  BEFORE_WRITE: 'loyalty.before-write',
  ACCOUNT_OPENED: 'loyalty.account-opened',
  EARNED: 'loyalty.points-earned',
  REDEEMED: 'loyalty.points-redeemed',
  EXPIRED: 'loyalty.points-expired',
  REVERSED: 'loyalty.points-reversed',
  ADJUSTED: 'loyalty.points-adjusted',
  /** Other modules can use it for promotions (customer groups) or perks. */
  TIER_CHANGED: 'loyalty.tier-changed',
} as const;

export interface LoyaltyEventData {
  accountId: string;
  customerId: string;
  points: number;
  balance: number;
  orderRef: string | null;
}

export interface TierChangedData {
  accountId: string;
  customerId: string;
  from: string | null;
  to: string | null;
}
