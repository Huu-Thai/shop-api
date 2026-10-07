/** Job names and payloads. Payloads carry ids, never whole rows. */
export const JOBS = {
  PURGE_REFRESH_TOKENS: 'purge-refresh-tokens',
  IMAGE_RENDITIONS: 'image-renditions',
  URL_REWRITES_REBUILD_STORE: 'url-rewrites-rebuild-store',
  PRICE_INDEX_REBUILD: 'price-index-rebuild',
  PRICE_INDEX_REFRESH: 'price-index-refresh',
  INVENTORY_EXPIRE_RESERVATIONS: 'inventory-expire-reservations',
  INVENTORY_RECONCILE: 'inventory-reconcile',
  SEARCH_INDEX_PRODUCTS: 'search-index-products',
  SEARCH_REINDEX_WEBSITE: 'search-reindex-website',
  SEARCH_SWITCH: 'search-switch',
  SEARCH_DROP_INDEXES: 'search-drop-indexes',
  SCHEDULER_RUN_DUE: 'scheduler-run-due',
  COUPONS_GENERATE: 'coupons-generate',
  LOYALTY_EXPIRE_POINTS: 'loyalty-expire-points',
  LOYALTY_EVALUATE_TIERS: 'loyalty-evaluate-tiers',
  CARTS_PURGE: 'carts-purge',
  ORDERS_EXPIRE_UNPAID: 'orders-expire-unpaid',
  PAYMENTS_RECONCILE: 'payments-reconcile',
  /** Runs one job execution (`jobs` queue; job id = execution id). */
  JOB_EXECUTE: 'job-execute',
  /** Fired by a defined job's cron schedule. */
  JOB_RUN_SCHEDULED: 'job-run-scheduled',
  /** Re-queues executions whose queue message was lost. */
  JOBS_REQUEUE: 'jobs-requeue',
  /** Deletes old executions and expired export/import files. */
  JOBS_CLEANUP: 'jobs-cleanup',
  WEBHOOK_DELIVER: 'webhook-deliver',
  WEBHOOKS_PURGE: 'webhooks-purge',
  AUDIT_PURGE: 'audit-purge',
} as const;

export interface JobExecuteJob {
  executionId: string;
}

export interface JobRunScheduledJob {
  jobId: string;
}

export interface WebhookDeliverJob {
  deliveryId: string;
}

export interface ImageRenditionsJob {
  imageId: string;
}

export interface UrlRewritesRebuildStoreJob {
  storeId: string;
  /** Coalescing generation (see queue/coalesce.ts). */
  generation?: number;
}

export interface PriceIndexRebuildJob {
  /** Absent = every priced variant. */
  variantIds?: string[];
  /** Full rebuilds only: coalescing generation (see queue/coalesce.ts). */
  generation?: number;
}

export interface SearchIndexProductsJob {
  productIds: string[];
}

export interface SearchWebsiteJob {
  websiteId: string;
  generation?: number;
}

export interface CouponsGenerateJob {
  promotionId: string;
  batchId: string;
  count: number;
  prefix: string;
  length: number;
  usageLimit: number;
  usesPerCustomer: number | null;
  expiresAt: string | null;
}
