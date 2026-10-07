import { entityEvents } from '../../common/events/entity.events.js';

export const INVENTORY_SOURCE_EVENTS = entityEvents('inventory-source');
export const INVENTORY_EVENTS = {
  BEFORE_WRITE: 'inventory.before-write',
  /** Stock or salable quantity changed (search in-stock facet, caches, back-in-stock). */
  CHANGED: 'inventory.changed',
  ADJUSTED: 'inventory.adjusted',
  WEBSITE_SOURCES_CHANGED: 'inventory.website-sources-changed',
  RESERVED: 'inventory.reserved',
  RELEASED: 'inventory.released',
  CONVERTED: 'inventory.converted',
  RECONCILED: 'inventory.reconciled',
} as const;

export interface InventoryChangedData {
  variantIds: string[];
}
