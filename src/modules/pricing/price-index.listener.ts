import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EntityEvent } from '../../common/events/entity.events.js';
import { COALESCE_DELAY_MS, nextGeneration } from '../../queue/coalesce.js';
import { JOBS, type PriceIndexRebuildJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import { CUSTOMER_GROUP_EVENTS } from '../customers/customers.events.js';
import {
  PRODUCT_EVENTS,
  type ProductEventData,
} from '../products/products.events.js';
import { ProductsQuery } from '../products/products.query.js';
import { STORE_EVENTS, WEBSITE_EVENTS } from '../stores/stores.events.js';
import { TAX_CHANGED_EVENTS } from '../tax/tax.events.js';
import {
  PRICE_BOOK_EVENTS,
  type PriceBookEventData,
} from './pricing.events.js';

const AFTER = { async: true, promisify: true } as const;
export const FULL_REBUILD_GENERATION_KEY = 'price-index:full-generation';

/** Keeps the price index in step with books, entries, tax, stores and groups (via the queue). */
@Injectable()
export class PriceIndexListener {
  constructor(
    @InjectQueue(QUEUES.PRICE_INDEX)
    private readonly queue: Queue<PriceIndexRebuildJob>,
    private readonly products: ProductsQuery,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Some variants (entries changed), or everything (coalesced, see queue/coalesce.ts). */
  async rebuild(variantIds?: string[]): Promise<void> {
    const opts = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    };
    if (variantIds) {
      if (variantIds.length)
        await this.queue.add(JOBS.PRICE_INDEX_REBUILD, { variantIds }, opts);
      return;
    }
    const generation = await nextGeneration(
      this.redis,
      FULL_REBUILD_GENERATION_KEY,
    );
    await this.queue.add(
      JOBS.PRICE_INDEX_REBUILD,
      { generation },
      { ...opts, delay: COALESCE_DELAY_MS },
    );
  }

  @OnEvent(PRICE_BOOK_EVENTS.ENTRIES_CHANGED, AFTER)
  onEntries(e: EntityEvent<PriceBookEventData>) {
    return this.rebuild(e.data.variantIds ?? []);
  }

  @OnEvent(PRICE_BOOK_EVENTS.CREATED, AFTER)
  @OnEvent(PRICE_BOOK_EVENTS.UPDATED, AFTER)
  @OnEvent(PRICE_BOOK_EVENTS.DELETED, AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[0], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[1], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[2], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[3], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[4], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[5], AFTER)
  @OnEvent(STORE_EVENTS.CREATED, AFTER)
  @OnEvent(STORE_EVENTS.UPDATED, AFTER)
  @OnEvent(WEBSITE_EVENTS.UPDATED, AFTER)
  @OnEvent(CUSTOMER_GROUP_EVENTS.CREATED, AFTER)
  @OnEvent(CUSTOMER_GROUP_EVENTS.UPDATED, AFTER)
  onScopeChanged() {
    return this.rebuild();
  }

  /** A product's tax class changes its gross prices. */
  @OnEvent(PRODUCT_EVENTS.UPDATED, AFTER)
  async onProductUpdated(e: EntityEvent<ProductEventData>) {
    if (e.data.taxClassChanged)
      await this.rebuild(
        await this.products.variantIdsOfProduct(e.data.productId),
      );
  }
}
