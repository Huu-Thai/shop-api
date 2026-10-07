import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type {
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { COALESCE_DELAY_MS, nextGeneration } from '../../queue/coalesce.js';
import {
  JOBS,
  type SearchIndexProductsJob,
  type SearchWebsiteJob,
} from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import {
  ATTRIBUTE_EVENTS,
  CATEGORY_EVENTS,
  type CategoryEventData,
} from '../catalog/catalog.events.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import {
  INVENTORY_EVENTS,
  type InventoryChangedData,
} from '../inventory/inventory.events.js';
import { PRICE_INDEX_EVENTS } from '../pricing/pricing.events.js';
import {
  PRODUCT_EVENTS,
  type ProductEventData,
} from '../products/products.events.js';
import { ProductsQuery } from '../products/products.query.js';
import {
  STORE_EVENTS,
  type StoreEventData,
  WEBSITE_EVENTS,
} from '../stores/stores.events.js';
import { StoresQuery } from '../stores/stores.query.js';
import { SearchEngines } from './search-engines.service.js';
import { SearchIndexer } from './search-indexer.js';
import { SearchSettingsQuery } from './search-settings.query.js';
import {
  type DocumentsChangedData,
  SEARCH_EVENTS,
  type SearchSettingsEventData,
} from './search.events.js';

const AFTER = { async: true, promisify: true } as const;
const BATCH = 200;
export const websiteGenerationKey = (websiteId: string) =>
  `search:reindex-generation:${websiteId}`;

/** Keeps search documents and engines in step with the catalog, prices and stock (idempotent). */
@Injectable()
export class SearchListener {
  constructor(
    @InjectQueue(QUEUES.SEARCH_INDEX)
    private readonly queue: Queue<SearchIndexProductsJob | SearchWebsiteJob>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly products: ProductsQuery,
    private readonly categories: CategoriesQuery,
    private readonly stores: StoresQuery,
    private readonly indexer: SearchIndexer,
    private readonly engines: SearchEngines,
    private readonly settings: SearchSettingsQuery,
  ) {}

  async indexProducts(productIds: readonly string[]): Promise<void> {
    const ids = [...new Set(productIds)];
    for (let i = 0; i < ids.length; i += BATCH)
      await this.queue.add(
        JOBS.SEARCH_INDEX_PRODUCTS,
        { productIds: ids.slice(i, i + BATCH) },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 200,
          removeOnFail: 200,
        },
      );
  }

  /** Whole websites, coalesced (see queue/coalesce.ts). */
  async reindexWebsites(websiteIds?: readonly string[]): Promise<void> {
    const ids = websiteIds?.length
      ? websiteIds
      : [
          ...new Set(
            [...(await this.stores.snapshot(true)).byId.values()].map(
              (s) => s.websiteId,
            ),
          ),
        ];
    for (const websiteId of ids) {
      const generation = await nextGeneration(
        this.redis,
        websiteGenerationKey(websiteId),
      );
      await this.queue.add(
        JOBS.SEARCH_REINDEX_WEBSITE,
        { websiteId, generation },
        {
          delay: COALESCE_DELAY_MS,
          attempts: 3,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    }
  }

  // ── products, prices, stock
  @OnEvent(PRODUCT_EVENTS.CREATED, AFTER)
  @OnEvent(PRODUCT_EVENTS.UPDATED, AFTER)
  @OnEvent(PRODUCT_EVENTS.DELETED, AFTER)
  @OnEvent(PRODUCT_EVENTS.RESTORED, AFTER)
  @OnEvent(PRODUCT_EVENTS.VARIANT_CREATED, AFTER)
  @OnEvent(PRODUCT_EVENTS.VARIANT_UPDATED, AFTER)
  @OnEvent(PRODUCT_EVENTS.VARIANT_DELETED, AFTER)
  @OnEvent(PRODUCT_EVENTS.STORE_OVERRIDE_CHANGED, AFTER)
  @OnEvent(PRODUCT_EVENTS.BUNDLE_CHANGED, AFTER)
  onProduct(e: EntityEvent<ProductEventData>) {
    return this.indexProducts([e.data.productId]);
  }

  @OnEvent(PRICE_INDEX_EVENTS.REBUILT, AFTER)
  @OnEvent(INVENTORY_EVENTS.CHANGED, AFTER)
  async onVariants(e: ProjectionEvent<InventoryChangedData>) {
    await this.indexProducts(
      await this.products.productIdsOfVariants(e.data.variantIds ?? []),
    );
  }

  // ── categories: products in the subtree, and documents still pointing at a moved/deleted category
  @OnEvent(CATEGORY_EVENTS.UPDATED, AFTER)
  @OnEvent(CATEGORY_EVENTS.MOVED, AFTER)
  @OnEvent(CATEGORY_EVENTS.DELETED, AFTER)
  async onCategory(e: EntityEvent<CategoryEventData>) {
    const subtree = await this.categories.subtreeIds(e.data.path);
    const ids = [
      ...(await this.products.productIdsInCategories(subtree)),
      ...(await this.indexer.productsWithCategory([
        e.data.categoryId,
        ...subtree,
      ])),
    ];
    await this.indexProducts(ids);
  }

  // ── labels/flags of attributes, stores and websites affect many documents
  @OnEvent(ATTRIBUTE_EVENTS.UPDATED, AFTER)
  @OnEvent(ATTRIBUTE_EVENTS.DELETED, AFTER)
  onAttribute() {
    return this.reindexWebsites();
  }

  @OnEvent(STORE_EVENTS.CREATED, AFTER)
  @OnEvent(STORE_EVENTS.UPDATED, AFTER)
  onStore(e: EntityEvent<StoreEventData>) {
    return this.reindexWebsites([e.data.websiteId]);
  }

  @OnEvent(WEBSITE_EVENTS.UPDATED, AFTER)
  onWebsite(e: EntityEvent) {
    return this.reindexWebsites([e.entityId]);
  }

  // ── engines
  @OnEvent(SEARCH_EVENTS.DOCUMENTS_CHANGED, AFTER)
  onDocuments(e: ProjectionEvent<DocumentsChangedData>) {
    return this.engines.push(
      e.data.storeId,
      e.data.localeCode,
      e.data.upserted,
      e.data.removed,
    );
  }

  @OnEvent(SEARCH_EVENTS.SETTINGS_UPDATED, AFTER)
  @OnEvent(SEARCH_EVENTS.SWITCH_STARTED, AFTER)
  @OnEvent(SEARCH_EVENTS.SWITCHED, AFTER)
  @OnEvent(SEARCH_EVENTS.SWITCH_FAILED, AFTER)
  onSettings(_e: EntityEvent<SearchSettingsEventData>) {
    return this.settings.invalidate();
  }
}
