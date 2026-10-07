import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { register } from 'prom-client';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { resolveStoreContext } from './context/store-context.guard.js';
import {
  NoStoreInterceptor,
  StorefrontCacheInterceptor,
  surrogateKeys,
} from './context/storefront-cache.interceptor.js';
import { ReferenceDataService } from './reference-data.service.js';
import { StoresCacheListener } from './stores-cache.listener.js';
import {
  purgesStorefront,
  responseTags,
  StorefrontResponseCache,
} from './context/storefront-response-cache.js';
import {
  hostOf,
  type StoreSnapshot,
  StoresQuery,
  type StoresSnapshot,
} from './stores.query.js';
import { StoresService, withDefault } from './stores.service.js';
import { StorefrontConfigController } from './storefront-config.controller.js';
import { WebsitesService } from './websites.service.js';

const snap = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({
  id: 'sid',
  code: 'vn-vi',
  name: 'VN',
  baseUrl: 'https://shop.example.vn',
  host: 'shop.example.vn',
  websiteId: 'wid',
  websiteCode: 'vn',
  websiteName: 'Vietnam',
  isActive: true,
  defaultLocaleCode: 'vi-VN',
  localeCodes: ['vi-VN', 'en-US'],
  defaultCurrencyCode: 'VND',
  currencyCodes: ['VND', 'USD'],
  countryCode: 'VN',
  pricesIncludeTax: true,
  ...over,
});
function snapshot(stores: StoreSnapshot[]): StoresSnapshot {
  const byHost = new Map<string, StoreSnapshot[]>();
  for (const s of stores)
    if (s.host) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s]);
  return {
    byCode: new Map(stores.map((s) => [s.code, s])),
    byId: new Map(stores.map((s) => [s.id, s])),
    byHost,
    locales: new Map([
      [
        'vi-VN',
        {
          code: 'vi-VN',
          name: 'Tiếng Việt',
          isActive: true,
          fallbackCode: 'en-US',
        },
      ],
      [
        'en-US',
        { code: 'en-US', name: 'English', isActive: true, fallbackCode: null },
      ],
      [
        'fr-FR',
        {
          code: 'fr-FR',
          name: 'Français',
          isActive: false,
          fallbackCode: 'en-US',
        },
      ],
    ]),
    fallbacks: new Map([
      ['vi-VN', 'en-US'],
      ['en-US', null],
    ]),
    currencies: new Map([
      [
        'VND',
        {
          code: 'VND',
          name: 'Dong',
          symbol: '₫',
          minorUnits: 0,
          isActive: true,
        },
      ],
      [
        'USD',
        {
          code: 'USD',
          name: 'Dollar',
          symbol: '$',
          minorUnits: 2,
          isActive: true,
        },
      ],
      [
        'EUR',
        {
          code: 'EUR',
          name: 'Euro',
          symbol: '€',
          minorUnits: 2,
          isActive: true,
        },
      ],
    ]),
  };
}

describe('resolveStoreContext', () => {
  const s = snapshot([
    snap(),
    snap({
      id: 'us',
      code: 'us-en',
      host: 'shop.example.com',
      websiteId: 'w2',
      defaultLocaleCode: 'en-US',
      localeCodes: ['en-US'],
      defaultCurrencyCode: 'USD',
      currencyCodes: ['USD'],
    }),
  ]);

  it('uses X-Store, negotiates locale and keeps a supported currency', () => {
    expect(
      resolveStoreContext(s, {
        storeCode: 'VN-VI',
        acceptLanguage: 'en-GB,en;q=0.9',
        currency: 'usd',
      }),
    ).toMatchObject({
      storeId: 'sid',
      websiteId: 'wid',
      localeCode: 'en-US',
      localeChain: ['en-US', 'vi-VN'],
      currencyCode: 'USD',
      pricesIncludeTax: true,
    });
  });

  it('falls back to store defaults for unknown locale/currency and prefers ?locale=', () => {
    expect(
      resolveStoreContext(s, {
        host: 'shop.example.vn',
        acceptLanguage: 'de',
        currency: 'EUR',
      }),
    ).toMatchObject({
      localeCode: 'vi-VN',
      localeChain: ['vi-VN', 'en-US'],
      currencyCode: 'VND',
    });
    expect(
      resolveStoreContext(s, {
        storeCode: 'vn-vi',
        locale: 'en-us',
        acceptLanguage: 'vi',
      }).localeCode,
    ).toBe('en-US');
  });

  it('rejects unknown, inactive, ambiguous and unresolvable stores', () => {
    expect(() => resolveStoreContext(s, { storeCode: 'nope' })).toThrow(
      NotFoundException,
    );
    expect(() => resolveStoreContext(s, {})).toThrow(BadRequestException);
    expect(() =>
      resolveStoreContext(snapshot([snap({ isActive: false })]), {
        storeCode: 'vn-vi',
      }),
    ).toThrow('not available');
    const twin = snapshot([snap(), snap({ id: 'x', code: 'vn-en' })]);
    expect(() =>
      resolveStoreContext(twin, { host: 'shop.example.vn' }),
    ).toThrow('Several stores');
  });

  it('ignores inactive locales', () => {
    const fr = snapshot([
      snap({ localeCodes: ['fr-FR'], defaultLocaleCode: 'fr-FR' }),
    ]);
    expect(resolveStoreContext(fr, { storeCode: 'vn-vi' }).localeCode).toBe(
      'fr-FR',
    ); // only the default is left
  });
});

const OFF = { enabled: false } as never;

describe('storefront caching', () => {
  it('derives surrogate keys from single resources and lists', () => {
    expect(surrogateKeys('product', { id: 'p1' }, 'us')).toEqual([
      'store:us',
      'product:p1',
    ]);
    expect(
      surrogateKeys('product', { data: [{ id: 'a' }, { id: 'b' }] }),
    ).toEqual(['product:list', 'product:a', 'product:b']);
    expect(surrogateKeys('category', [{ id: 'c' }])).toEqual([
      'category:list',
      'category:c',
    ]);
    expect(surrogateKeys(undefined, { id: 'x' }, 'us')).toEqual(['store:us']);
  });

  it('sets cache headers on storefront GETs only', async () => {
    const headers: Record<string, string> = {};
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('product');
    const ctx = (method: string) =>
      ({
        getHandler: () => null,
        getClass: () => null,
        switchToHttp: () => ({
          getRequest: () => ({
            method,
            storeContext: { storeCode: 'us', localeCode: 'en-US' },
          }),
          getResponse: () => ({
            setHeader: (k: string, v: string) => (headers[k] = v),
          }),
        }),
      }) as never;
    const i = new StorefrontCacheInterceptor(reflector, OFF);
    await lastValueFrom(
      i.intercept(ctx('GET'), { handle: () => of({ id: 'p1' }) }),
    );
    expect(headers).toMatchObject({
      'Content-Language': 'en-US',
      'Surrogate-Key': 'store:us product:p1',
      Vary: 'X-Store, Accept-Language, X-Currency, Authorization',
    });
    delete headers['Cache-Control'];
    await lastValueFrom(i.intercept(ctx('POST'), { handle: () => of({}) }));
    expect(headers['Cache-Control']).toBeUndefined();
  });

  it('never lets a shared cache keep a signed-in shopper’s response', async () => {
    const headers: Record<string, string> = {};
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('product');
    const http = {
      getRequest: () => ({
        method: 'GET',
        storeContext: { storeCode: 'us', customer: { id: 'c' } },
      }),
      getResponse: () => ({
        setHeader: (k: string, v: string) => (headers[k] = v),
      }),
    };
    const ctx = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => http,
    } as never;
    await lastValueFrom(
      new StorefrontCacheInterceptor(reflector, OFF).intercept(ctx, {
        handle: () => of({ id: 'p1' }),
      }),
    );
    expect(headers).toEqual({ 'Cache-Control': 'private, no-store' });
    delete headers['Cache-Control'];
    await lastValueFrom(
      new NoStoreInterceptor().intercept(ctx, { handle: () => of({}) }),
    );
    expect(headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('StorefrontResponseCache', () => {
  const config = (ttlSeconds: number) =>
    ({ get: () => ({ ttlSeconds }) }) as never;
  const store = {
    storeCode: 'us',
    localeCode: 'en-US',
    currencyCode: 'USD',
  } as never;

  function redisDouble() {
    const data = new Map<string, string>();
    const incr = vi.fn((k: string) => {
      data.set(k, String(Number(data.get(k) ?? 0) + 1));
    });
    return {
      data,
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      mget: vi.fn(async (...keys: string[]) =>
        keys.map((k) => data.get(k) ?? null),
      ),
      set: vi.fn(
        async (k: string, v: string, ..._ttl: unknown[]) => void data.set(k, v),
      ),
      pipeline: vi.fn(() => {
        const ops: (() => void)[] = [];
        const p = {
          incr: (k: string) => (ops.push(() => incr(k)), p),
          set: (k: string, v: string, ..._ttl: unknown[]) => (
            ops.push(() => void data.set(k, v)),
            p
          ),
          exec: vi.fn(async () => ops.forEach((op) => op())),
        };
        return p;
      }),
      incr,
    };
  }

  it('tags responses with the products they show', () => {
    expect(
      responseTags(
        {
          id: 'p1',
          sku: 'TEE',
          related: [{ id: 'p2', sku: 'MUG' }],
          variants: [{ id: 'v1' }],
        },
        ['category:c1'],
      ),
    ).toEqual(['all', 'category:c1', 'product:p1', 'product:p2']);
    expect(responseTags({ data: [{ id: 'p3', sku: 'X' }] })).toEqual([
      'all',
      'product:p3',
    ]);
    expect(responseTags(null)).toEqual(['all']);
  });

  it('serves an entry while its tags are unchanged; a purge of any of them drops it', async () => {
    const redis = redisDouble();
    const cache = new StorefrontResponseCache(redis as never, config(30));
    expect(cache.enabled).toBe(true);
    const url = '/api/v1/store/products/p1';
    expect(await cache.get(store, url)).toBeUndefined();
    await cache.set(store, url, { id: 'p1' }, ['all', 'product:p1']);
    expect(redis.set.mock.calls[0].slice(2)).toEqual(['EX', 30]);
    expect(await cache.get(store, url)).toEqual({ id: 'p1' });
    expect(
      await cache.get(
        { ...(store as object), currencyCode: 'VND' } as never,
        url,
      ),
    ).toBeUndefined();
    // Another product's stock: still a hit; this product's: a miss.
    await cache.purge(['product:p2', 'category:c9']);
    expect(await cache.get(store, url)).toEqual({ id: 'p1' });
    await cache.purge(['product:p1']);
    expect(await cache.get(store, url)).toBeUndefined();
    // Catalog-wide changes (committed after-events) drop everything.
    await cache.set(store, url, { id: 'p1' }, ['all', 'product:p1']);
    for (const name of [
      'inventory.changed',
      'order.placed',
      'search.documents-changed',
      'page.published',
    ])
      await cache.onEvent({ name, eventId: 'e' });
    await cache.onEvent({ name: 'product.before-write' });
    await cache.onEvent({ name: 'price-index.before-rebuild' });
    expect(await cache.get(store, url)).toEqual({ id: 'p1' });
    await cache.onEvent({ name: 'product.updated', eventId: 'e' });
    expect(await cache.get(store, url)).toBeUndefined();
    await cache.onEvent(undefined);
    expect(purgesStorefront({ name: 'category.updated', eventId: 'e' })).toBe(
      true,
    );
    // Nothing cached holds prices or stock: their changes never purge.
    for (const name of [
      'inventory.website-sources-changed',
      'price-index.rebuilt',
      'tax-rate.updated',
    ])
      expect(purgesStorefront({ name, eventId: 'e' })).toBe(false);
    expect(purgesStorefront({ name: 'cart.updated', eventId: 'e' })).toBe(
      false,
    );
    expect(purgesStorefront({ eventId: 'e' })).toBe(false);
    const m = await register
      .getSingleMetric('shop_storefront_cache_total')!
      .get();
    expect(m.values.map((v) => v.labels.result).sort()).toEqual([
      'hit',
      'miss',
    ]);
  });

  it('caches read-model parts under the current catalog version', async () => {
    const redis = redisDouble();
    const cache = new StorefrontResponseCache(redis as never, config(30));
    const first = await cache.getModels(['product:a', 'card:b']);
    expect(first.values).toEqual([undefined, undefined]);
    await cache.setModels(
      [
        { key: 'product:a', value: { name: 'A' } },
        { key: 'card:b', value: null },
      ],
      first.version,
    );
    expect((await cache.getModels(['product:a', 'card:b'])).values).toEqual([
      { name: 'A' },
      null,
    ]);
    // Built before a catalog change landed: stale at once.
    await cache.purge(['all']);
    expect((await cache.getModels(['product:a'])).values).toEqual([undefined]);
    await cache.setModels([], null);
    expect(await cache.getModels([])).toEqual({ values: [], version: null });
    redis.mget.mockRejectedValueOnce(new Error('down'));
    expect((await cache.getModels(['x'])).values).toEqual([undefined]);
    redis.pipeline.mockImplementationOnce(() => {
      throw new Error('down');
    });
    await expect(
      cache.setModels([{ key: 'x', value: 1 }], null),
    ).resolves.toBeUndefined();
    const off = new StorefrontResponseCache(redis as never, config(0));
    expect((await off.getModels(['x'])).values).toEqual([undefined]);
    await off.setModels([{ key: 'x', value: 1 }], null);
  });

  it('a purge while the response was being built makes it stale at once', async () => {
    const redis = redisDouble();
    const cache = new StorefrontResponseCache(redis as never, config(30));
    const [before] = await cache.versions(['all']);
    await cache.purge(['all']); // lands while rendering
    await cache.set(
      store,
      '/x',
      { id: 'x' },
      ['all'],
      new Map([['all', before]]),
    );
    expect(await cache.get(store, '/x')).toBeUndefined();
  });

  it('skips huge bodies, survives Redis trouble, and can be switched off', async () => {
    const redis = redisDouble();
    const cache = new StorefrontResponseCache(redis as never, config(30));
    await cache.set(store, '/big', { s: 'x'.repeat(600 * 1024) }, ['all']);
    await cache.set(store, '/undef', undefined, ['all']);
    expect(redis.set).not.toHaveBeenCalled();
    redis.get.mockRejectedValue(new Error('down'));
    expect(await cache.get(store, '/a')).toBeUndefined();
    redis.mget.mockRejectedValue(new Error('down'));
    await expect(cache.set(store, '/a', {}, ['all'])).resolves.toBeUndefined();
    redis.pipeline.mockImplementation(() => {
      throw new Error('down');
    });
    await expect(cache.purge(['all'])).resolves.toBeUndefined();
    await cache.purge([]);
    const off = new StorefrontResponseCache(redis as never, config(0));
    expect(off.enabled).toBe(false);
    await off.purge(['all']);
  });

  it('the interceptor serves opted-in anonymous GETs from the cache and fills misses', async () => {
    const headers: Record<string, string> = {};
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(
      (key: unknown) =>
        key === 'storefront:responseCache'
          ? { categoryParam: 'id' }
          : 'product',
    );
    const req = {
      method: 'GET',
      originalUrl: '/api/v1/store/categories/c1/products',
      params: { id: 'c1' },
      storeContext: store as unknown,
    };
    const ctx = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({
          setHeader: (k: string, v: string) => (headers[k] = v),
        }),
      }),
    } as never;
    const cache = {
      enabled: true,
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      versions: vi.fn(async () => ['3', '7']),
    };
    const i = new StorefrontCacheInterceptor(reflector, cache as never);
    const body = { data: [{ id: 'p1', sku: 'TEE' }] };
    const handle = vi.fn(() => of(body));
    expect(await lastValueFrom(i.intercept(ctx, { handle }))).toEqual(body);
    expect(headers['X-Cache']).toBe('MISS');
    expect(cache.versions).toHaveBeenCalledWith(['all', 'category:c1']);
    expect(cache.set).toHaveBeenCalledWith(
      store,
      '/api/v1/store/categories/c1/products',
      body,
      ['all', 'category:c1', 'product:p1'],
      new Map([
        ['all', '3'],
        ['category:c1', '7'],
      ]),
    );
    cache.get.mockResolvedValueOnce(body as never);
    expect(await lastValueFrom(i.intercept(ctx, { handle }))).toEqual(body);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(headers).toMatchObject({
      'X-Cache': 'HIT',
      'Surrogate-Key': 'store:us product:list product:p1',
    });
    // Version read trouble: still served and cached (versions unknown → treated as current).
    cache.versions.mockRejectedValueOnce(new Error('down'));
    await lastValueFrom(i.intercept(ctx, { handle }));
    expect(handle).toHaveBeenCalledTimes(2);
    // Signed-in shoppers are never served from (or written to) the cache.
    req.storeContext = { ...(store as object), customer: { id: 'c' } };
    await lastValueFrom(i.intercept(ctx, { handle }));
    expect(cache.get).toHaveBeenCalledTimes(3);
    expect(headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('StoresQuery', () => {
  function setup() {
    const prisma = fakePrisma();
    prisma.store.findMany.mockResolvedValue([
      {
        id: 's1',
        code: 'vn-vi',
        name: 'VN',
        baseUrl: 'https://Shop.Example.vn',
        websiteId: 'w1',
        website: { code: 'vn', name: 'Vietnam', isActive: false },
        isActive: true,
        defaultLocaleCode: 'vi-VN',
        locales: [{ localeCode: 'en-US' }],
        defaultCurrencyCode: 'VND',
        currencies: [],
        countryCode: 'VN',
        pricesIncludeTax: true,
      },
    ]);
    prisma.locale.findMany.mockResolvedValue([
      { code: 'vi-VN', name: 'VI', isActive: true, fallbackCode: 'en-US' },
    ]);
    prisma.currency.findMany.mockResolvedValue([]);
    let version = '1';
    const redis = {
      get: vi.fn(async () => version),
      incr: vi.fn(async () => 2),
    };
    return {
      q: new StoresQuery(prisma as never, redis as never),
      prisma,
      redis,
      bump: () => (version = '2'),
    };
  }

  it('builds the snapshot (defaults included, host-indexed, website activity applied)', async () => {
    const { q } = setup();
    const s = await q.snapshot();
    expect(s.byCode.get('vn-vi')).toMatchObject({
      host: 'shop.example.vn',
      isActive: false,
      localeCodes: ['vi-VN', 'en-US'],
      currencyCodes: ['VND'],
    });
    expect(s.byHost.get('shop.example.vn')).toHaveLength(1);
    expect(s.fallbacks.get('vi-VN')).toBe('en-US');
    expect(await q.storesOfWebsites(['w1'])).toHaveLength(1);
    expect(await q.store('nope')).toBeUndefined();
  });

  it('caches, re-checks the version, reloads on change and invalidates cluster-wide', async () => {
    const { q, prisma, redis, bump } = setup();
    await Promise.all([q.snapshot(), q.snapshot()]);
    expect(prisma.store.findMany).toHaveBeenCalledTimes(1); // single flight
    await q.snapshot();
    expect(prisma.store.findMany).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + 6_000 });
    await q.snapshot(); // version unchanged → no reload
    expect(prisma.store.findMany).toHaveBeenCalledTimes(1);
    bump();
    vi.setSystemTime(Date.now() + 6_000);
    await q.snapshot();
    expect(prisma.store.findMany).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await new StoresCacheListener(q).onStoreConfigChanged();
    expect(redis.incr).toHaveBeenCalled();
    await q.snapshot();
    expect(prisma.store.findMany).toHaveBeenCalledTimes(3);
  });

  it('parses hosts', () => {
    expect(hostOf('https://A.example.com:8443')).toBe('a.example.com:8443');
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe('ReferenceDataService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new ReferenceDataService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }
  const locales = [
    { code: 'en-US', fallbackCode: null },
    { code: 'vi-VN', fallbackCode: 'en-US' },
    { code: 'en-GB', fallbackCode: 'en-US' },
  ];

  it('creates locales with a valid fallback and rejects cycles', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.locale.findMany.mockResolvedValue(locales);
    prisma.locale.create.mockResolvedValue({
      id: 'l1',
      code: 'vi-CN',
      name: 'x',
      isActive: false,
      fallbackCode: 'vi-VN',
    });
    expect(
      await svc.createLocale(
        { code: 'vi-CN', name: 'x', fallbackCode: 'vi-VN' },
        ROOT,
      ),
    ).not.toHaveProperty('id');
    expect(afterNames()).toEqual(['locale.created']);
    await expect(
      svc.createLocale(
        { code: 'x-YY', name: 'x', fallbackCode: 'zz' } as never,
        ROOT,
      ),
    ).rejects.toThrow('does not exist');
    await expect(
      svc.updateLocale('en-US', { fallbackCode: 'vi-VN' }, ROOT),
    ).rejects.toThrow(); // not found (no findUnique) or cycle
    prisma.locale.findUnique.mockResolvedValue({
      id: 'l0',
      code: 'en-US',
      name: 'E',
      isActive: true,
      fallbackCode: null,
    });
    await expect(
      svc.updateLocale('en-US', { fallbackCode: 'vi-VN' }, ROOT),
    ).rejects.toThrow('cycle');
  });

  it('refuses to deactivate locales and currencies in use', async () => {
    const { svc, prisma } = setup();
    prisma.locale.findUnique.mockResolvedValue({
      id: 'l',
      code: 'vi-VN',
      name: 'VI',
      isActive: true,
      fallbackCode: 'en-US',
    });
    prisma.store.count.mockResolvedValue(2);
    await expect(
      svc.updateLocale('vi-VN', { isActive: false }, ROOT),
    ).rejects.toBeInstanceOf(ConflictException);
    prisma.currency.findUnique.mockResolvedValue({
      id: 'c',
      code: 'VND',
      name: 'D',
      symbol: '₫',
      minorUnits: 0,
      isActive: true,
    });
    await expect(
      svc.updateCurrency('VND', { isActive: false }, ROOT),
    ).rejects.toBeInstanceOf(ConflictException);
    prisma.currency.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateCurrency('XXX', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('records only real changes and lists active rows', async () => {
    const { svc, prisma, afterNames } = setup();
    const row = {
      id: 'c',
      code: 'VND',
      name: 'D',
      symbol: '₫',
      minorUnits: 0,
      isActive: false,
    };
    prisma.currency.findUnique.mockResolvedValue(row);
    prisma.currency.update
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, isActive: true });
    await svc.updateCurrency('VND', { name: 'D' }, ROOT);
    await svc.updateCurrency('VND', { isActive: true }, ROOT);
    expect(afterNames()).toEqual(['currency.updated']);
    prisma.currency.create.mockResolvedValue({ ...row, code: 'CHF' });
    await svc.createCurrency(
      { code: 'CHF', name: 'Franc', symbol: 'CHF', minorUnits: 2 },
      ROOT,
    );
    await svc.locales(true);
    expect(prisma.locale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    await svc.currencies();
  });

  it('updates a locale', async () => {
    const { svc, prisma, afterNames } = setup();
    const row = {
      id: 'l',
      code: 'vi-VN',
      name: 'VI',
      isActive: false,
      fallbackCode: 'en-US',
    };
    prisma.locale.findUnique.mockResolvedValue(row);
    prisma.locale.update.mockResolvedValue({ ...row, isActive: true });
    expect(
      await svc.updateLocale('vi-VN', { isActive: true }, ROOT),
    ).toMatchObject({ isActive: true });
    expect(afterNames()).toEqual(['locale.updated']);
  });
});

describe('WebsitesService & StoresService', () => {
  const website = {
    id: 'w1',
    code: 'vn',
    name: 'VN',
    baseCurrencyCode: 'VND',
    defaultStoreId: null,
    position: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    stores: [{ code: 'vn-vi' }],
  };
  const storeRow = (o: object = {}) => ({
    id: 's1',
    websiteId: 'w1',
    code: 'vn-vi',
    name: 'VN',
    baseUrl: null,
    defaultLocaleCode: 'vi-VN',
    defaultCurrencyCode: 'VND',
    countryCode: 'VN',
    pricesIncludeTax: true,
    position: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    locales: [{ localeCode: 'vi-VN' }, { localeCode: 'en-US' }],
    currencies: [{ currencyCode: 'VND' }],
    ...o,
  });
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      websites: new WebsitesService(prisma as never, fb.bus),
      stores: new StoresService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }

  it('websites: list/get/create/update/delete with currency and default-store checks', async () => {
    const { websites, prisma, afterNames } = setup();
    prisma.website.findMany.mockResolvedValue([website]);
    expect((await websites.list())[0].stores).toEqual(['vn-vi']);
    await expect(websites.get('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      websites.create({ code: 'x', name: 'X', baseCurrencyCode: 'EUR' }, ROOT),
    ).rejects.toThrow('not active');
    prisma.currency.findUnique.mockResolvedValue({ isActive: true });
    prisma.website.create.mockResolvedValue(website);
    await websites.create(
      { code: 'vn', name: 'VN', baseCurrencyCode: 'VND' },
      ROOT,
    );
    prisma.website.findUnique.mockResolvedValue(website);
    prisma.store.findUnique.mockResolvedValue({ websiteId: 'other' });
    await expect(
      websites.update('w1', { defaultStoreId: 's9' }, ROOT),
    ).rejects.toThrow('must be a store of this website');
    prisma.store.findUnique.mockResolvedValue({ websiteId: 'w1' });
    prisma.website.update.mockResolvedValue({
      ...website,
      defaultStoreId: 's1',
    });
    expect(
      (await websites.update('w1', { defaultStoreId: 's1' }, ROOT))
        .defaultStoreId,
    ).toBe('s1');
    await websites.remove('w1', ROOT);
    expect(afterNames()).toEqual([
      'website.created',
      'website.updated',
      'website.deleted',
    ]);
    prisma.website.findUnique.mockResolvedValue(null);
    await expect(websites.remove('w1', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(websites.update('w1', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('stores: default locale/currency always enabled, first store becomes the website default', async () => {
    const { stores, prisma, after } = setup();
    prisma.website.findUnique.mockResolvedValue({ defaultStoreId: null });
    prisma.locale.findMany.mockResolvedValue([
      { code: 'vi-VN' },
      { code: 'en-US' },
    ]);
    prisma.currency.findMany.mockResolvedValue([{ code: 'VND' }]);
    prisma.store.create.mockResolvedValue(storeRow());
    const s = await stores.create(
      {
        websiteId: 'w1',
        code: 'vn-vi',
        name: 'VN',
        defaultLocaleCode: 'vi-VN',
        localeCodes: ['en-US', 'vi-VN'],
        defaultCurrencyCode: 'VND',
        countryCode: 'VN',
      },
      ROOT,
    );
    expect(s.localeCodes).toEqual(['vi-VN', 'en-US']);
    expect(prisma.store.create.mock.calls[0][0].data.locales.create).toEqual([
      { localeCode: 'vi-VN', position: 0 },
      { localeCode: 'en-US', position: 1 },
    ]);
    expect(prisma.website.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { defaultStoreId: 's1' },
    });
    expect(after[0]).toMatchObject({
      name: 'store.created',
      data: { localesChanged: true },
    });
  });

  it('stores: rejects inactive locales/currencies and unknown websites', async () => {
    const { stores, prisma } = setup();
    await expect(
      stores.create(
        {
          websiteId: 'w',
          code: 'x',
          name: 'X',
          defaultLocaleCode: 'vi-VN',
          defaultCurrencyCode: 'VND',
          countryCode: 'VN',
        },
        ROOT,
      ),
    ).rejects.toThrow('does not exist');
    prisma.website.findUnique.mockResolvedValue({ defaultStoreId: 's0' });
    const err = await stores
      .create(
        {
          websiteId: 'w',
          code: 'x',
          name: 'X',
          defaultLocaleCode: 'vi-VN',
          defaultCurrencyCode: 'VND',
          countryCode: 'VN',
        },
        ROOT,
      )
      .catch((e: BadRequestException) => e.getResponse());
    expect(JSON.stringify(err)).toContain(
      'Locales not found or inactive: vi-VN',
    );
  });

  it('stores: update reports locale changes for URL rebuilds; delete; list/get', async () => {
    const { stores, prisma, after } = setup();
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.locale.findMany.mockResolvedValue([{ code: 'vi-VN' }]);
    prisma.currency.findMany.mockResolvedValue([
      { code: 'VND' },
      { code: 'USD' },
    ]);
    prisma.store.update.mockResolvedValue(
      storeRow({
        locales: [{ localeCode: 'vi-VN' }],
        currencies: [{ currencyCode: 'USD' }, { currencyCode: 'VND' }],
      }),
    );
    await stores.update(
      's1',
      { localeCodes: [], currencyCodes: ['USD'] },
      ROOT,
    );
    const data = prisma.store.update.mock.calls[0][0].data;
    expect(data.locales.create).toEqual([{ localeCode: 'vi-VN', position: 0 }]);
    expect(data.currencies.create).toEqual([
      { currencyCode: 'VND' },
      { currencyCode: 'USD' },
    ]);
    expect(after[0]).toMatchObject({
      name: 'store.updated',
      data: { localesChanged: true },
    });
    await stores.remove('s1', ROOT);
    expect(after[1]).toMatchObject({ name: 'store.deleted' });
    prisma.store.findMany.mockResolvedValue([storeRow()]);
    expect(await stores.list('w1')).toHaveLength(1);
    expect((await stores.get('s1')).currencyCodes).toEqual(['VND']);
    prisma.store.findUnique.mockResolvedValue(null);
    await expect(stores.get('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(stores.update('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(stores.remove('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('withDefault puts the default first without duplicates', () => {
    expect(withDefault('a', ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('StorefrontConfigController', () => {
  it('returns the resolved store, its active locales/currencies and sibling stores', async () => {
    const s = snapshot([
      snap(),
      snap({ id: 'x', code: 'vn-en', host: null, defaultLocaleCode: 'en-US' }),
      snap({ id: 'y', code: 'other', websiteId: 'w9' }),
    ]);
    const c = new StorefrontConfigController({
      snapshot: async () => s,
    } as never);
    const out = await c.config(
      resolveStoreContext(s, { storeCode: 'vn-vi', currency: 'USD' }),
    );
    expect(out).toMatchObject({
      store: { code: 'vn-vi', defaultCurrency: 'VND' },
      website: { code: 'vn' },
      locale: 'vi-VN',
      currency: 'USD',
    });
    expect(out.locales.map((l) => l.code)).toEqual(['vi-VN', 'en-US']);
    expect(out.currencies.map((c) => c.code)).toEqual(['VND', 'USD']);
    expect(out.stores.map((x) => x.code)).toEqual(['vn-vi', 'vn-en']);
  });
});
