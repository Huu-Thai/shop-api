import { entityEvents } from '../../common/events/entity.events.js';

export const PRODUCT_EVENTS = {
  ...entityEvents('product'),
  RESTORED: 'product.restored',
  VARIANT_CREATED: 'product.variant-created',
  VARIANT_UPDATED: 'product.variant-updated',
  VARIANT_DELETED: 'product.variant-deleted',
  BUNDLE_CHANGED: 'product.bundle-changed',
  STORE_OVERRIDE_CHANGED: 'product.store-override-changed',
  RELATIONS_CHANGED: 'product.relations-changed',
} as const;

/** `product.before-write` input: lets other modules veto (URL collisions). */
export interface ProductWriteInput {
  sku?: string;
  /** Product tax class being set (validated by the tax module). */
  taxClassId?: string | null;
  slugs: { localeCode: string; slug: string }[];
}

/** Data on product after-events. */
export interface ProductEventData {
  productId: string;
  /** Slugs or website assignment changed: storefront URLs must be rebuilt. */
  urlsChanged: boolean;
  variantId?: string;
  /** The product tax class changed: indexed gross prices must be rebuilt. */
  taxClassChanged?: boolean;
}
