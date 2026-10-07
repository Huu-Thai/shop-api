import { createHmac } from 'node:crypto';
import type { BaseEvent } from '../../common/events/base.event.js';

/**
 * Events integrations can subscribe to, and what they mean. Only these leave the system: their
 * payloads are ids and amounts — never actors' identities, changed values or secrets.
 */
export const WEBHOOK_EVENTS_CATALOGUE: Record<string, string> = {
  'order.placed':
    'An order was placed (waiting for payment, or paid with points)',
  'order.paid': 'An order is paid in full',
  'order.canceled': 'An order was cancelled',
  'order.shipped': 'A shipment left (order fully or partly fulfilled)',
  'order.delivered': 'A shipment was delivered',
  'order.refunded': 'A refund was recorded on an order (credit memo issued)',
  'order.completed': 'An order is paid and fulfilled',
  'payment.captured': 'Money was captured for an order',
  'payment.failed': 'A payment attempt failed',
  'payment.refunded': 'A refund succeeded at the provider',
  'payment.refund-failed': 'A refund failed at the provider',
  'product.created': 'A product was created',
  'product.updated': 'A product changed (changedFields lists what)',
  'product.deleted': 'A product was deleted',
  'product.restored': 'A deleted product was restored',
  'inventory.changed': 'Stock of some variants changed (variantIds)',
  'customer.created': 'A customer account was created by staff',
  'customer.registered': 'A shopper signed up on the storefront',
  'customer.updated': 'A customer account changed',
  'customer.deleted': 'A customer account was deleted',
  'job-execution.succeeded': 'A job, import or export finished',
  'job-execution.failed': 'A job, import or export failed',
  'job-execution.canceled': 'A job, import or export was cancelled',
  // Storefront content: for caches and search indexes that must follow what shoppers see.
  'category.created': 'A category was created',
  'category.updated': 'A category changed (changedFields lists what)',
  'category.deleted': 'A category was deleted',
  'category.moved': 'A category moved in the tree',
  'page.created': 'A CMS page was created',
  'page.updated': 'A CMS page changed',
  'page.deleted': 'A CMS page was deleted',
  'page.published': 'A CMS page went live (now or at its scheduled time)',
  'page.unpublished': 'A CMS page was taken down',
  'post.created': 'A blog post was created',
  'post.updated': 'A blog post changed',
  'post.deleted': 'A blog post was deleted',
  'post.published': 'A blog post went live (now or at its scheduled time)',
  'post.unpublished': 'A blog post was taken down',
  'block.updated': 'A content block changed',
  'block.deleted': 'A content block was deleted',
  'block.published': 'A content block went live',
  'block.unpublished': 'A content block was taken down',
  'block-placement.created': 'A block was placed on a page, post, category or product',
  'block-placement.updated': 'A block placement changed',
  'block-placement.deleted': 'A block placement was removed',
  'menu.created': 'A navigation menu was created',
  'menu.updated': 'A navigation menu changed',
  'menu.deleted': 'A navigation menu was deleted',
  'menu-item.created': 'A menu item was added',
  'menu-item.updated': 'A menu item changed',
  'menu-item.deleted': 'A menu item was removed',
  'banner.created': 'A banner was created',
  'banner.updated': 'A banner changed',
  'banner.deleted': 'A banner was deleted',
  'slider.updated': 'A slider changed',
  'slider.deleted': 'A slider was deleted',
  'slide.created': 'A slide was added',
  'slide.updated': 'A slide changed',
  'slide.deleted': 'A slide was removed',
  'price-book.entries-changed': 'Prices in a price book changed',
  'url-rewrites.rebuilt': 'Storefront URLs were rebuilt',
  'store.updated': 'A store’s settings changed',
};

/** Sent by "test" (POST /admin/webhooks/:id/test); every webhook receives it. */
export const PING_EVENT = 'webhook.ping';

/** `order.*` style patterns or exact names; true when `event` is covered. */
export function matches(patterns: readonly string[], event: string): boolean {
  return patterns.some((p) =>
    p.endsWith('.*') ? event.startsWith(p.slice(0, -1)) : p === event,
  );
}

/** Patterns that cover at least one catalogue event (rejects typos). */
export function unknownPatterns(patterns: readonly string[]): string[] {
  const names = Object.keys(WEBHOOK_EVENTS_CATALOGUE);
  return patterns.filter((p) => !names.some((n) => matches([p], n)));
}

/** The public body of an event: its id, type, time and data (ids, amounts). */
export function webhookPayload(event: BaseEvent): Record<string, unknown> {
  const e = event as BaseEvent & {
    entityType?: string;
    entityId?: string;
    data?: Record<string, unknown>;
    audit?: { changes?: Record<string, unknown> };
  };
  const changes = e.audit?.changes;
  return {
    id: e.eventId,
    type: e.name,
    createdAt: new Date(e.occurredAt).toISOString(),
    data: {
      ...(e.entityType
        ? { entityType: e.entityType, entityId: e.entityId }
        : {}),
      ...e.data,
      ...(e.name.endsWith('.updated') && changes
        ? { changedFields: Object.keys(changes) }
        : {}),
    },
  };
}

/**
 * `X-Shop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` — the receiver
 * recomputes it with the webhook's secret and rejects old timestamps (replays).
 */
export function signature(secret: string, body: string, at: number): string {
  const t = Math.floor(at / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
