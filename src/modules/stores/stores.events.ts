import { entityEvents } from '../../common/events/entity.events.js';

export const LOCALE_EVENTS = entityEvents('locale');
export const CURRENCY_EVENTS = entityEvents('currency');
export const WEBSITE_EVENTS = entityEvents('website');
export const STORE_EVENTS = entityEvents('store');

/** Every after-event that changes what the storefront resolves (store context cache). */
export const STORE_CONFIG_EVENTS = [
  LOCALE_EVENTS.CREATED,
  LOCALE_EVENTS.UPDATED,
  CURRENCY_EVENTS.CREATED,
  CURRENCY_EVENTS.UPDATED,
  WEBSITE_EVENTS.CREATED,
  WEBSITE_EVENTS.UPDATED,
  WEBSITE_EVENTS.DELETED,
  STORE_EVENTS.CREATED,
  STORE_EVENTS.UPDATED,
  STORE_EVENTS.DELETED,
] as const;

/** `store.created` / `store.updated` data: lets URL rewrites rebuild when a store's locales change. */
export interface StoreEventData {
  storeId: string;
  websiteId: string;
  localeCodes: string[];
  localesChanged: boolean;
}
