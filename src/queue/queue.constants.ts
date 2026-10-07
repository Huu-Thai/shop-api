/**
 * Queue names (PLAN.md §5). Always reference these constants, never string literals.
 * Phase 0 runs `maintenance`; the others are registered now so producers and the queue CLI
 * can rely on them, and gain processors in their phases.
 */
export const QUEUES = {
  MAINTENANCE: 'maintenance',
  SCHEDULER: 'scheduler',
  JOBS: 'jobs',
  // Catalog projections (URL rewrites rebuilds).
  CATALOG: 'catalog',
  SEARCH_INDEX: 'search-index',
  PRICE_INDEX: 'price-index',
  INVENTORY: 'inventory',
  MEDIA: 'media',
  NOTIFICATIONS: 'notifications',
  LOYALTY: 'loyalty',
  COUPONS: 'coupons',
  // Checkout housekeeping (unpaid orders, reconciliation, cart purge).
  CHECKOUT: 'checkout',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
