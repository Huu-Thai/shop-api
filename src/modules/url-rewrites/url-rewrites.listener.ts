import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { EntityEvent } from '../../common/events/entity.events.js';
import {
  CATEGORY_EVENTS,
  type CategoryEventData,
} from '../catalog/catalog.events.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import {
  PRODUCT_EVENTS,
  type ProductEventData,
} from '../products/products.events.js';
import { STORE_EVENTS, type StoreEventData } from '../stores/stores.events.js';
import { UrlRewritesService } from './url-rewrites.service.js';

const AFTER = { async: true, promisify: true } as const;

/**
 * Keeps the URL projection in step with the catalog (after-events; idempotent). Small changes are
 * rebuilt inline, whole stores in the `catalog` queue.
 */
@Injectable()
export class UrlRewritesListener {
  constructor(
    private readonly rewrites: UrlRewritesService,
    private readonly categories: CategoriesQuery,
  ) {}

  @OnEvent(PRODUCT_EVENTS.CREATED, AFTER)
  onProductCreated(e: EntityEvent<ProductEventData>) {
    return this.product(e);
  }

  @OnEvent(PRODUCT_EVENTS.UPDATED, AFTER)
  onProductUpdated(e: EntityEvent<ProductEventData>) {
    return this.product(e);
  }

  @OnEvent(PRODUCT_EVENTS.DELETED, AFTER)
  onProductDeleted(e: EntityEvent<ProductEventData>) {
    return this.product(e);
  }

  @OnEvent(PRODUCT_EVENTS.RESTORED, AFTER)
  onProductRestored(e: EntityEvent<ProductEventData>) {
    return this.product(e);
  }

  @OnEvent(CATEGORY_EVENTS.CREATED, AFTER)
  onCategoryCreated(e: EntityEvent<CategoryEventData>) {
    return this.category(e);
  }

  @OnEvent(CATEGORY_EVENTS.UPDATED, AFTER)
  onCategoryUpdated(e: EntityEvent<CategoryEventData>) {
    return this.category(e);
  }

  @OnEvent(CATEGORY_EVENTS.MOVED, AFTER)
  onCategoryMoved(e: EntityEvent<CategoryEventData>) {
    return this.category(e);
  }

  @OnEvent(CATEGORY_EVENTS.DELETED, AFTER)
  async onCategoryDeleted(e: EntityEvent<CategoryEventData>) {
    await this.rewrites.rebuildCategories([e.data.categoryId]);
  }

  @OnEvent(STORE_EVENTS.CREATED, AFTER)
  onStoreCreated(e: EntityEvent<StoreEventData>) {
    return this.store(e);
  }

  @OnEvent(STORE_EVENTS.UPDATED, AFTER)
  onStoreUpdated(e: EntityEvent<StoreEventData>) {
    return this.store(e);
  }

  private async product(e: EntityEvent<ProductEventData>) {
    if (e.data.urlsChanged)
      await this.rewrites.rebuildProduct(e.data.productId);
  }

  /** Slug, assignment or parent changes affect the whole subtree's paths. */
  private async category(e: EntityEvent<CategoryEventData>) {
    if (!e.data.urlsChanged) return;
    await this.rewrites.rebuildCategories(
      await this.categories.subtreeIds(e.data.path),
    );
  }

  private async store(e: EntityEvent<StoreEventData>) {
    if (e.data.localesChanged)
      await this.rewrites.enqueueStoreRebuild([e.data.storeId]);
  }
}
