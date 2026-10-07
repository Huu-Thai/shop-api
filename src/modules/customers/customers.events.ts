import type { ActorRef } from '../../common/auth/principal.js';
import { entityEvents } from '../../common/events/entity.events.js';
import type { StorefrontCustomer } from '../stores/context/store-context.js';

export const CUSTOMER_GROUP_EVENTS = entityEvents('customer-group');

/** Before-write input: the tax module vetoes a tax class that isn't a CUSTOMER class. */
export interface CustomerGroupWriteInput {
  taxClassId?: string | null;
}

/** The group of anonymous shoppers (storefront prices for visitors who aren't signed in). */
export const GUEST_GROUP = 'guest';
/** The group new storefront accounts join. */
export const DEFAULT_CUSTOMER_GROUP = 'general';

export const CUSTOMER_EVENTS = {
  ...entityEvents('customer'),
  /** A shopper signed up on the storefront (loyalty opens an account). */
  REGISTERED: 'customer.registered',
  LOGGED_IN: 'customer.logged-in',
  LOGIN_FAILED: 'customer.login-failed',
  LOCKED: 'customer.locked',
  LOGGED_OUT: 'customer.logged-out',
  PASSWORD_CHANGED: 'customer.password-changed',
  TOKEN_REUSE_DETECTED: 'customer.token-reuse-detected',
  BEFORE_SESSION_WRITE: 'customer.before-session-write',
} as const;
export const CUSTOMER_ADDRESS_EVENTS = entityEvents('customer-address');

/** Data of customer created/registered/updated/deleted events (plain JSON). */
export interface CustomerEventData {
  customerId: string;
  websiteId: string;
  customerGroupId: string;
}

export const customerActor = (
  c: Pick<StorefrontCustomer, 'id' | 'email'>,
): ActorRef => ({ type: 'customer', id: c.id, label: c.email });
