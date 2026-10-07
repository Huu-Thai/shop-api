import { entityEvents } from '../../common/events/entity.events.js';

export const PRICE_BOOK_EVENTS = {
  ...entityEvents('price-book'),
  ENTRIES_CHANGED: 'price-book.entries-changed',
} as const;
export const EXCHANGE_RATE_EVENTS = entityEvents('exchange-rate');
export const PRICE_INDEX_EVENTS = {
  REBUILT: 'price-index.rebuilt',
  BEFORE_REBUILD: 'price-index.before-rebuild',
} as const;

export interface PriceBookEventData {
  priceBookId: string;
  /** Variants whose prices changed (entries); absent = the whole book (scope, dates, deletion). */
  variantIds?: string[];
}
