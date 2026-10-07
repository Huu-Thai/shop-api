import { entityEvents } from '../../common/events/entity.events.js';

export const TAX_CLASS_EVENTS = entityEvents('tax-class');
export const TAX_ZONE_EVENTS = entityEvents('tax-zone');
export const TAX_RATE_EVENTS = entityEvents('tax-rate');

/** After-events that change tax results (tax cache, gross prices in the price index). */
export const TAX_CHANGED_EVENTS = [
  TAX_ZONE_EVENTS.CREATED,
  TAX_ZONE_EVENTS.UPDATED,
  TAX_ZONE_EVENTS.DELETED,
  TAX_RATE_EVENTS.CREATED,
  TAX_RATE_EVENTS.UPDATED,
  TAX_RATE_EVENTS.DELETED,
] as const;
