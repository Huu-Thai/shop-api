import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';

export interface StoreSnapshot {
  id: string;
  code: string;
  name: string;
  baseUrl: string | null;
  /** Lower-cased host of `baseUrl` (with port), for Host-based resolution. */
  host: string | null;
  websiteId: string;
  websiteCode: string;
  websiteName: string;
  /** Store and its website are both active. */
  isActive: boolean;
  defaultLocaleCode: string;
  localeCodes: string[];
  defaultCurrencyCode: string;
  currencyCodes: string[];
  countryCode: string;
  pricesIncludeTax: boolean;
}

export interface LocaleInfo {
  code: string;
  name: string;
  isActive: boolean;
  fallbackCode: string | null;
}

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
  isActive: boolean;
}

export interface StoresSnapshot {
  byCode: Map<string, StoreSnapshot>;
  byId: Map<string, StoreSnapshot>;
  byHost: Map<string, StoreSnapshot[]>;
  locales: Map<string, LocaleInfo>;
  fallbacks: Map<string, string | null>;
  currencies: Map<string, CurrencyInfo>;
}

export const STORES_VERSION_KEY = 'stores:config-version';
/** How often the version key is checked, and the hard maximum age of a snapshot. */
const CHECK_MS = 5_000;
const MAX_AGE_MS = 60_000;

export function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Read model of websites/stores/locales/currencies shared by every process. Cached in memory and
 * invalidated cluster-wide through a Redis version counter bumped by store after-events
 * (StoresCacheListener), so the storefront hot path costs at most one Redis GET per 5 s.
 */
@Injectable()
export class StoresQuery {
  private readonly logger = new Logger(StoresQuery.name);
  private cached?: {
    snapshot: StoresSnapshot;
    version: string | null;
    loadedAt: number;
    checkedAt: number;
  };
  private loading?: Promise<StoresSnapshot>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * `fresh` reloads from the database now — background jobs triggered by a store change must not
   * act on a copy that may be up to 5 s old (a missing store would drop its URLs or prices).
   */
  async snapshot(fresh = false): Promise<StoresSnapshot> {
    if (fresh) {
      const version = await this.redis
        .get(STORES_VERSION_KEY)
        .catch(() => null);
      const snapshot = await this.load();
      this.cached = {
        snapshot,
        version,
        loadedAt: Date.now(),
        checkedAt: Date.now(),
      };
      return snapshot;
    }
    const now = Date.now();
    const c = this.cached;
    if (c && now - c.checkedAt < CHECK_MS && now - c.loadedAt < MAX_AGE_MS)
      return c.snapshot;
    const version = await this.redis
      .get(STORES_VERSION_KEY)
      .catch(() => c?.version ?? null);
    if (c && version === c.version && now - c.loadedAt < MAX_AGE_MS) {
      c.checkedAt = now;
      return c.snapshot;
    }
    // Single flight: concurrent requests share one reload.
    this.loading ??= this.load()
      .then((snapshot) => {
        this.cached = {
          snapshot,
          version,
          loadedAt: Date.now(),
          checkedAt: Date.now(),
        };
        return snapshot;
      })
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** Called after store config changes: drop the local copy and tell other processes. */
  async invalidate(): Promise<void> {
    this.cached = undefined;
    await this.redis
      .incr(STORES_VERSION_KEY)
      .catch((e: Error) =>
        this.logger.warn(`Could not bump ${STORES_VERSION_KEY}: ${e.message}`),
      );
  }

  async store(id: string, fresh = false): Promise<StoreSnapshot | undefined> {
    return (await this.snapshot(fresh)).byId.get(id);
  }

  /** Stores of the given websites (for URL rewrites and other per-store projections). */
  async storesOfWebsites(
    websiteIds: readonly string[],
    fresh = false,
  ): Promise<StoreSnapshot[]> {
    const ids = new Set(websiteIds);
    return [...(await this.snapshot(fresh)).byId.values()].filter((s) =>
      ids.has(s.websiteId),
    );
  }

  private async load(): Promise<StoresSnapshot> {
    const [stores, locales, currencies] = await Promise.all([
      this.prisma.store.findMany({
        orderBy: [{ position: 'asc' }, { code: 'asc' }],
        include: {
          website: { select: { code: true, name: true, isActive: true } },
          locales: {
            select: { localeCode: true },
            orderBy: { position: 'asc' },
          },
          currencies: { select: { currencyCode: true } },
        },
      }),
      this.prisma.locale.findMany({
        select: { code: true, name: true, isActive: true, fallbackCode: true },
      }),
      this.prisma.currency.findMany({
        select: {
          code: true,
          name: true,
          symbol: true,
          minorUnits: true,
          isActive: true,
        },
      }),
    ]);
    const snapshot: StoresSnapshot = {
      byCode: new Map(),
      byId: new Map(),
      byHost: new Map(),
      locales: new Map(locales.map((l) => [l.code, l])),
      fallbacks: new Map(locales.map((l) => [l.code, l.fallbackCode])),
      currencies: new Map(currencies.map((c) => [c.code, c])),
    };
    for (const s of stores) {
      const localeCodes = s.locales.map((l) => l.localeCode);
      const currencyCodes = s.currencies.map((c) => c.currencyCode);
      const snap: StoreSnapshot = {
        id: s.id,
        code: s.code,
        name: s.name,
        baseUrl: s.baseUrl,
        host: hostOf(s.baseUrl),
        websiteId: s.websiteId,
        websiteCode: s.website.code,
        websiteName: s.website.name,
        isActive: s.isActive && s.website.isActive,
        defaultLocaleCode: s.defaultLocaleCode,
        localeCodes: localeCodes.includes(s.defaultLocaleCode)
          ? localeCodes
          : [s.defaultLocaleCode, ...localeCodes],
        defaultCurrencyCode: s.defaultCurrencyCode,
        currencyCodes: currencyCodes.includes(s.defaultCurrencyCode)
          ? currencyCodes
          : [s.defaultCurrencyCode, ...currencyCodes],
        countryCode: s.countryCode,
        pricesIncludeTax: s.pricesIncludeTax,
      };
      snapshot.byCode.set(snap.code, snap);
      snapshot.byId.set(snap.id, snap);
      if (snap.host)
        snapshot.byHost.set(snap.host, [
          ...(snapshot.byHost.get(snap.host) ?? []),
          snap,
        ]);
    }
    return snapshot;
  }
}
