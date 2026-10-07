import { entityEvents } from '../../common/events/entity.events.js';

/** Cart changes are projections (not audited): high volume, personal, short-lived. */
export const CART_EVENTS = {
  ...entityEvents('cart'),
  MERGED: 'cart.merged',
  CONVERTED: 'cart.converted',
} as const;
