import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { Counter, register } from 'prom-client';
import type { AppConfig } from '../../../config/configuration.js';
import { REDIS_CLIENT } from '../../../redis/redis.module.js';
import type { StoreContext } from './store-context.js';

/** Every entry carries this tag: bumping it drops the whole cache. */
export const ALL_TAG = 'all';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TAGS = 200;
const tagKey = (tag: string) => `storefront:tag:${tag}`;

/**
 * Changes that can alter cached catalog data (structure, texts, attributes, media, URLs, stores):
 * they drop everything. Nothing cached holds prices or stock — those are computed on every request
 * — so stock (every checkout), price and tax changes never purge.
 */
const PURGE_ALL = new Set([
  'attribute',
  'attribute-set',
  'category',
  'currency',
  'image',
  'image-links',
  'locale',
  'product',
  'search-settings',
  'store',
  'url-rewrite',
  'url-rewrites',
  'website',
]);

/** Committed after-events only (they carry the outbox `eventId`; before-events never do). */
export const purgesStorefront = (event: {
  name?: string;
  eventId?: string;
}): boolean =>
  !!event.eventId &&
  !!event.name &&
  PURGE_ALL.has(event.name.slice(0, event.name.indexOf('.')));

/** Tags of a response: every product in it (objects with `id` and `sku`), plus the given ones. */
export function responseTags(
  body: unknown,
  extra: readonly string[] = [],
): string[] {
  const tags = new Set<string>([ALL_TAG, ...extra]);
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || tags.size >= MAX_TAGS || !v || typeof v !== 'object')
      return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && typeof o.sku === 'string')
      tags.add(`product:${o.id}`);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(body, 0);
  return [...tags].slice(0, MAX_TAGS);
}

interface Entry {
  body: unknown;
  tags: string[];
  versions: (string | null)[];
}

const counter = () => {
  register.removeSingleMetric('shop_storefront_cache_total');
  return new Counter({
    name: 'shop_storefront_cache_total',
    help: 'Storefront response cache lookups by result (hit, miss)',
    labelNames: ['result'] as const,
  });
};

/**
 * Storefront caches in Redis (PLAN.md §6, §12): whole anonymous responses of routes that opt in
 * (category tree and categories) and read-model parts (product pages and cards without prices and
 * stock, which are computed on every request). Each entry records the versions of its tags; it is
 * served only while none moved, so a catalog change drops it at once in every process. Entries also
 * expire after STOREFRONT_CACHE_TTL_S.
 */
@Injectable()
export class StorefrontResponseCache {
  private readonly logger = new Logger(StorefrontResponseCache.name);
  private readonly ttl: number;
  private readonly lookups = counter();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppConfig, true>,
  ) {
    this.ttl = config.get('storefrontCache', { infer: true }).ttlSeconds;
  }

  get enabled(): boolean {
    return this.ttl > 0;
  }

  private key(ctx: StoreContext, url: string): string {
    const h = createHash('sha1')
      .update(`${ctx.storeCode}|${ctx.localeCode}|${ctx.currencyCode}|${url}`)
      .digest('hex');
    return `storefront:cache:${h}`;
  }

  /** Current versions of tags (null = never bumped). */
  versions(tags: readonly string[]): Promise<(string | null)[]> {
    return this.redis.mget(...tags.map(tagKey));
  }

  /** The cached body while all its tags are unchanged; Redis trouble counts as a miss. */
  async get(ctx: StoreContext, url: string): Promise<unknown> {
    try {
      const raw = await this.redis.get(this.key(ctx, url));
      const entry = raw ? (JSON.parse(raw) as Entry) : undefined;
      const fresh =
        !!entry &&
        (await this.versions(entry.tags)).every(
          (v, i) => v === entry.versions[i],
        );
      this.lookups.inc({ result: fresh ? 'hit' : 'miss' });
      return fresh ? entry.body : undefined;
    } catch (e) {
      this.logger.warn(`Storefront cache read failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Stores a response with its tags. `before` holds tag versions read before the response was
   * built: a purge that landed meanwhile makes the entry stale at once.
   */
  async set(
    ctx: StoreContext,
    url: string,
    body: unknown,
    tags: readonly string[],
    before: ReadonlyMap<string, string | null> = new Map(),
  ): Promise<void> {
    try {
      const json = JSON.stringify(body);
      if (json === undefined || json.length > MAX_BODY_BYTES) return;
      const now = await this.versions(tags);
      const versions = tags.map((t, i) =>
        before.has(t) ? before.get(t)! : now[i],
      );
      const entry: Entry = { body, tags: [...tags], versions };
      await this.redis.set(
        this.key(ctx, url),
        JSON.stringify(entry),
        'EX',
        this.ttl,
      );
    } catch (e) {
      this.logger.warn(
        `Storefront cache write failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Cached read-model parts (catalog data without prices or stock), by key. Returns the values in
   * order (undefined = miss) and the `all` version to store new ones with.
   */
  async getModels<T>(
    keys: readonly string[],
  ): Promise<{ values: (T | undefined)[]; version: string | null }> {
    const miss = { values: keys.map(() => undefined), version: null };
    if (!this.enabled || !keys.length) return miss;
    try {
      const [version] = await this.versions([ALL_TAG]);
      const raw = await this.redis.mget(
        ...keys.map((k) => `storefront:model:${k}`),
      );
      const values = raw.map((r) => {
        const entry = r ? (JSON.parse(r) as Entry) : undefined;
        return entry && entry.versions[0] === version
          ? (entry.body as T)
          : undefined;
      });
      for (const v of values)
        this.lookups.inc({ result: v === undefined ? 'miss' : 'hit' });
      return { values, version };
    } catch (e) {
      this.logger.warn(`Storefront cache read failed: ${(e as Error).message}`);
      return miss;
    }
  }

  /** Stores read-model parts under the `all` version read before they were built. */
  async setModels(
    entries: readonly { key: string; value: unknown }[],
    version: string | null,
  ): Promise<void> {
    if (!this.enabled || !entries.length) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const e of entries) {
        const entry: Entry = {
          body: e.value,
          tags: [ALL_TAG],
          versions: [version],
        };
        pipeline.set(
          `storefront:model:${e.key}`,
          JSON.stringify(entry),
          'EX',
          this.ttl,
        );
      }
      await pipeline.exec();
    } catch (e) {
      this.logger.warn(
        `Storefront cache write failed: ${(e as Error).message}`,
      );
    }
  }

  /** Drops every entry carrying one of these tags. */
  async purge(tags: readonly string[]): Promise<void> {
    if (!this.enabled || !tags.length) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const t of tags) pipeline.incr(tagKey(t));
      await pipeline.exec();
    } catch (e) {
      this.logger.warn(
        `Storefront cache purge failed: ${(e as Error).message}`,
      );
    }
  }

  @OnEvent('**')
  async onEvent(
    event: { name?: string; eventId?: string } | undefined,
  ): Promise<void> {
    if (event && purgesStorefront(event)) await this.purge([ALL_TAG]);
  }
}
