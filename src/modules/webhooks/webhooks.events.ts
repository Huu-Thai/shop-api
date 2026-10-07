import { entityEvents } from '../../common/events/entity.events.js';

export const WEBHOOK_EVENTS = {
  ...entityEvents('webhook'),
  SECRET_ROTATED: 'webhook.secret-rotated',
  /** Switched off after too many failed deliveries, or a 410 Gone answer. */
  DISABLED: 'webhook.disabled',
  DELIVERY_BEFORE_WRITE: 'webhook-delivery.before-write',
} as const;
