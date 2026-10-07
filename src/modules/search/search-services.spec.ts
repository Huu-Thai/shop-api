import { BadRequestException, NotFoundException } from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { SearchEngines } from './search-engines.service.js';
import { SearchIndexer } from './search-indexer.js';
import { SearchSettingsQuery } from './search-settings.query.js';
import { SearchSettingsService } from './search-settings.service.js';
import {
  SearchAdminController,
  StorefrontSearchController,
} from './search.controllers.js';
import { SearchListener } from './search.listener.js';
import { SearchProcessor } from './search.processor.js';
import { CircuitBreaker, SearchService } from './search.service.js';

const secrets = {
  seal: (v: object) => `sealed:${JSON.stringify(v)}`,
  open: (s: string) => JSON.parse(s.replace(/^sealed:/, '')),
  enabled: true,
};
const redis = () => {
  const kv: Record<string, string> = {};
  return {
    get: vi.fn(async (k: string) => kv[k] ?? null),
    incr: vi.fn(async (k: string) =>
      Number((kv[k] = String(Number(kv[k] ?? 0) + 1))),
    ),
    kv,
  };
};
const store = {
  id: 's1',
  code: 'main',
  websiteId: 'w',
  localeCodes: ['en-US', 'vi-VN'],
  isActive: true,
  defaultCurrencyCode: 'USD',
};
const storesQuery = () => ({
  snapshot: vi.fn(async () => ({
    byId: new Map([['s1', store]]),
    byCode: new Map([['main', store]]),
    byHost: new Map(),
    locales: new Map([
      ['en-US', { isActive: true }],
      ['vi-VN', { isActive: false }],
    ]),
    fallbacks: new Map([['en-US', null]]),
    currencies: new Map(),
  })),
  store: vi.fn(async (id: string) => (id === 's1' ? store : undefined)),
  storesOfWebsites: vi.fn(async () => [store]),
});
const row = (o: object = {}) => ({
  websiteId: 'w',
  provider: 'POSTGRES',
  connection: null,
  activeGeneration: 0,
  pendingProvider: null,
  pendingConnection: null,
  pendingGeneration: null,
  indexPrefix: 'shop',
  synonyms: [],
  stopwords: [],
  status: 'READY',
  lastError: null,
  lastBuiltAt: null,
  buildStartedAt: null,
  ...o,
});

describe('SearchSettingsQuery', () => {
  it('defaults to Postgres and decrypts engine connections', async () => {
    const prisma = fakePrisma();
    prisma.searchSettings.findMany.mockResolvedValue([
      row({
        websiteId: 'm',
        provider: 'MEILISEARCH',
        connection: 'sealed:{"url":"http://m"}',
        pendingProvider: 'OPENSEARCH',
        pendingConnection: 'broken',
        pendingGeneration: 2,
      }),
    ]);
    const q = new SearchSettingsQuery(
      prisma as never,
      {
        open: (s: string) => {
          if (s === 'broken') throw new Error('bad');
          return secrets.open(s);
        },
      } as never,
      redis() as never,
    );
    expect((await q.effective('other')).active).toEqual({
      provider: 'POSTGRES',
      generation: 0,
    });
    const m = await q.effective('m', true);
    expect(m.active).toEqual({
      provider: 'MEILISEARCH',
      connection: { url: 'http://m' },
      generation: 0,
    });
    expect(m.pending).toEqual({
      provider: 'OPENSEARCH',
      connection: undefined,
      generation: 2,
    });
    await q.invalidate();
  });
});

describe('SearchSettingsService', () => {
  function setup() {
    const prisma = fakePrisma();
    prisma.website.count.mockResolvedValue(1);
    const fb = fakeBus(prisma);
    const health = vi.fn(async () => undefined);
    const providers = { for: vi.fn(() => ({ health })) };
    const queue = {
      add: vi.fn(async (_n: string, _d: object, _o: object) => undefined),
    };
    prisma.searchDocument.groupBy.mockResolvedValue([
      { storeId: 's1', localeCode: 'en-US', _count: { _all: 4 } },
    ]);
    const svc = new SearchSettingsService(
      prisma as never,
      fb.bus,
      secrets as never,
      providers as never,
      storesQuery() as never,
      queue as never,
    );
    return { svc, prisma, health, queue, ...fb };
  }

  it('status masks credentials and counts documents', async () => {
    const { svc, prisma } = setup();
    prisma.searchSettings.findUnique.mockResolvedValue(
      row({
        provider: 'MEILISEARCH',
        connection: 'sealed:{"url":"http://m","apiKey":"k"}',
        pendingProvider: 'OPENSEARCH',
        pendingConnection: 'garbage',
        pendingGeneration: 2,
      }),
    );
    const s = await svc.status('w');
    expect(s.active).toEqual({
      provider: 'MEILISEARCH',
      url: 'http://m',
      generation: 0,
    });
    expect(s.pending).toEqual({
      provider: 'OPENSEARCH',
      url: null,
      generation: 2,
    });
    expect(JSON.stringify(s)).not.toContain('"k"');
    expect(s.documents).toEqual([
      { storeCode: 'main', localeCode: 'en-US', documents: 4 },
    ]);
    prisma.searchSettings.findUnique.mockResolvedValue(null);
    expect((await svc.status('w')).active).toEqual({
      provider: 'POSTGRES',
      url: null,
      generation: 0,
    });
    prisma.website.count.mockResolvedValue(0);
    await expect(svc.status('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.update('x', { provider: 'POSTGRES' }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.reindex('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a new engine is health-checked, sealed and built in the background', async () => {
    const { svc, prisma, queue, afterNames, health } = setup();
    await expect(
      svc.update('w', { provider: 'MEILISEARCH' }, ROOT),
    ).rejects.toThrow('connection is required');
    health.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      svc.update(
        'w',
        { provider: 'MEILISEARCH', connection: { url: 'http://m' } },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.update(
      'w',
      {
        provider: 'MEILISEARCH',
        connection: { url: 'http://m', apiKey: 'k' },
        synonyms: [[' Tee ', 'Shirt'], ['solo']],
      },
      ROOT,
    );
    const data = prisma.searchSettings.upsert.mock.calls[0][0].create;
    expect(data).toMatchObject({
      pendingProvider: 'MEILISEARCH',
      pendingGeneration: 1,
      status: 'BUILDING',
      synonyms: [['tee', 'shirt']],
    });
    expect(data.pendingConnection).toBe(
      'sealed:{"url":"http://m","apiKey":"k"}',
    );
    expect(queue.add).toHaveBeenCalledWith(
      'search-switch',
      { websiteId: 'w', generation: 1 },
      expect.anything(),
    );
    expect(afterNames()).toEqual(['search-settings.switch-started']);
  });

  it('unchanged engine settings only update; changed analysis rebuilds external engines', async () => {
    const { svc, prisma, queue, afterNames } = setup();
    prisma.searchSettings.findUnique.mockResolvedValue(
      row({
        provider: 'MEILISEARCH',
        connection: 'sealed:{"url":"http://m"}',
        activeGeneration: 3,
      }),
    );
    await svc.update('w', { provider: 'MEILISEARCH' }, ROOT);
    expect(queue.add).not.toHaveBeenCalled();
    await svc.update(
      'w',
      { provider: 'MEILISEARCH', stopwords: ['the'] },
      ROOT,
    );
    expect(queue.add).toHaveBeenCalledWith(
      'search-switch',
      { websiteId: 'w', generation: 4 },
      expect.anything(),
    );
    prisma.searchSettings.findUnique.mockResolvedValue(row());
    await svc.update(
      'w',
      { provider: 'POSTGRES', synonyms: [['a', 'b']] },
      ROOT,
    ); // Postgres expands at query time: no build
    expect(afterNames()).toEqual([
      'search-settings.updated',
      'search-settings.switch-started',
      'search-settings.updated',
    ]);
    await svc.reindex('w');
    expect(queue.add).toHaveBeenLastCalledWith(
      'search-reindex-website',
      { websiteId: 'w' },
      expect.anything(),
    );
  });
});

describe('SearchEngines', () => {
  function setup(settings: object) {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const provider = {
      kind: 'MEILISEARCH',
      health: vi.fn(),
      createIndex: vi.fn(),
      index: vi.fn(),
      remove: vi.fn(),
      dropIndex: vi.fn(),
    };
    const providers = { for: vi.fn(() => provider) };
    const settingsQuery = {
      effective: vi.fn(async () => ({
        websiteId: 'w',
        prefix: 'shop',
        synonyms: [],
        stopwords: [],
        status: 'READY',
        buildStartedAt: null,
        active: { provider: 'POSTGRES', generation: 0 },
        ...settings,
      })),
    };
    const queue = {
      add: vi.fn(async (_n: string, _d: object, _o: object) => undefined),
    };
    const config = { get: () => ({ dropDelayMs: 500 }) };
    const engines = new SearchEngines(
      prisma as never,
      fb.bus,
      storesQuery() as never,
      settingsQuery as never,
      providers as never,
      secrets as never,
      queue as never,
      config as never,
    );
    return { engines, prisma, provider, queue, ...fb };
  }

  it('pushes changes to the active and pending external engines only', async () => {
    const pg = setup({});
    await pg.engines.push('s1', 'en-US', ['a'], []);
    expect(pg.provider.index).not.toHaveBeenCalled();
    const both = setup({
      active: {
        provider: 'MEILISEARCH',
        connection: { url: 'm' },
        generation: 1,
      },
      pending: {
        provider: 'OPENSEARCH',
        connection: { url: 'o' },
        generation: 2,
      },
    });
    both.prisma.searchDocument.findMany.mockResolvedValue([
      { document: { id: 'a' } },
    ]);
    await both.engines.push('s1', 'en-US', ['a'], ['b']);
    expect(both.provider.index.mock.calls.map((c) => c[0].index)).toEqual([
      'shop_g1_main_en-us',
      'shop_g2_main_en-us',
    ]);
    expect(both.provider.remove).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'shop_g2_main_en-us' }),
      ['b'],
    );
    await both.engines.push('gone', 'en-US', ['a'], []);
  });

  it('switch: builds, copies with catch-up, flips and schedules the old indexes for dropping', async () => {
    const s = setup({
      active: {
        provider: 'OPENSEARCH',
        connection: { url: 'o' },
        generation: 1,
      },
      pending: {
        provider: 'MEILISEARCH',
        connection: { url: 'm' },
        generation: 2,
      },
    });
    s.prisma.searchDocument.findMany
      .mockResolvedValueOnce([{ id: 'd1', document: { id: 'a' } }])
      .mockResolvedValue([]);
    s.prisma.searchSettings.findUnique.mockResolvedValue(
      row({
        provider: 'OPENSEARCH',
        connection: 'sealed:{"url":"o"}',
        activeGeneration: 1,
        pendingProvider: 'MEILISEARCH',
        pendingConnection: 'sealed:{"url":"m"}',
        pendingGeneration: 2,
      }),
    );
    expect(await s.engines.switch('w', 2)).toEqual({ copied: 1 });
    expect(s.provider.createIndex).toHaveBeenCalledTimes(2); // two locales
    expect(s.prisma.searchSettings.update.mock.calls[0][0].data).toMatchObject({
      provider: 'MEILISEARCH',
      activeGeneration: 2,
      pendingProvider: null,
      status: 'READY',
    });
    expect(s.afterNames()).toEqual(['search-settings.switched']);
    expect(s.queue.add).toHaveBeenCalledWith(
      'search-drop-indexes',
      expect.objectContaining({
        provider: 'OPENSEARCH',
        connection: 'sealed:{"url":"o"}',
      }),
      expect.objectContaining({ delay: 500 }),
    );
    expect(
      await s.engines.drop({
        provider: 'OPENSEARCH',
        connection: 'sealed:{"url":"o"}',
        targets: [
          { storeId: 's1', storeCode: 'main', localeCode: 'en-US', index: 'x' },
        ],
      }),
    ).toBe(1);
  });

  it('switch to Postgres needs no build; stale generations and superseded builds are skipped', async () => {
    const pg = setup({
      active: { provider: 'POSTGRES', generation: 0 },
      pending: { provider: 'POSTGRES', generation: 1 },
    });
    pg.prisma.searchSettings.findUnique.mockResolvedValue(
      row({ pendingProvider: 'POSTGRES', pendingGeneration: 1 }),
    );
    expect(await pg.engines.switch('w', 1)).toEqual({ copied: 0 });
    expect(pg.provider.createIndex).not.toHaveBeenCalled();
    expect(pg.queue.add).not.toHaveBeenCalled();
    expect(await pg.engines.switch('w', 9)).toEqual({
      skipped: 'generation 9 is not pending',
    });
    pg.prisma.searchSettings.findUnique.mockResolvedValue(
      row({ pendingProvider: 'POSTGRES', pendingGeneration: 5 }),
    );
    expect(await pg.engines.switch('w', 1)).toEqual({
      skipped: 'generation 1 was superseded during the build',
    });
  });

  it('a failed build marks the switch FAILED and keeps the active engine', async () => {
    const s = setup({
      pending: {
        provider: 'MEILISEARCH',
        connection: { url: 'm' },
        generation: 1,
      },
    });
    s.provider.health.mockRejectedValue(new Error('unreachable'));
    await expect(s.engines.switch('w', 1)).rejects.toThrow('unreachable');
    expect(s.prisma.searchSettings.updateMany).toHaveBeenCalledWith({
      where: { websiteId: 'w', pendingGeneration: 1 },
      data: { status: 'FAILED', lastError: 'unreachable' },
    });
    expect(s.afterNames()).toEqual(['search-settings.switch-failed']);
  });
});

describe('SearchIndexer', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const view = {
      id: 'p1',
      sku: 'P',
      type: 'SIMPLE',
      name: 'Tee',
      slug: 'tee',
      shortDescription: null,
      description: null,
      attributes: {},
      variants: [],
      visibility: 'CATALOG_SEARCH',
      createdAt: new Date(1),
      categoryIds: ['c'],
    };
    const products = {
      view: vi.fn(async (_c: unknown, id: string) =>
        id === 'p1' ? view : undefined,
      ),
      idsOnWebsite: vi.fn(async () => ['p1']),
    };
    const attributes = {
      searchCodes: vi.fn(async () => ({
        filterable: ['color'],
        searchable: ['material'],
      })),
      localized: vi.fn(async () => new Map()),
    };
    const categories = {
      withAncestors: vi.fn(async () => new Map([['c', { path: 'root/c' }]])),
    };
    const storefront = {
      cards: vi.fn(async () => [
        { id: 'p1', price: { amount: 100 }, inStock: true },
      ]),
    };
    const indexer = new SearchIndexer(
      prisma as never,
      fb.bus,
      storesQuery() as never,
      products as never,
      attributes as never,
      categories as never,
      storefront as never,
    );
    return { indexer, prisma, ...fb };
  }

  it('upserts visible products per store × active locale and removes the rest', async () => {
    const { indexer, prisma, after } = setup();
    expect(await indexer.indexProducts(['p1', 'gone', 'p1'])).toEqual({
      upserted: 1,
      removed: 1,
    });
    const sql = prisma.$executeRaw.mock.calls[0];
    const doc = JSON.parse(
      sql.find(
        (a: unknown) => typeof a === 'string' && a.startsWith('{"id"'),
      ) as string,
    );
    expect(doc).toMatchObject({
      id: 'p1',
      price: 100,
      inStock: true,
      categoryIds: ['root', 'c'],
    });
    expect(prisma.searchDocument.deleteMany).toHaveBeenCalledWith({
      where: {
        storeId: 's1',
        localeCode: 'en-US',
        entityType: 'PRODUCT',
        entityId: { in: ['gone'] },
      },
    });
    expect(after[0]).toMatchObject({
      name: 'search.documents-changed',
      data: {
        storeId: 's1',
        localeCode: 'en-US',
        upserted: ['p1'],
        removed: ['gone'],
      },
    });
    expect(await indexer.indexProducts([])).toEqual({
      upserted: 0,
      removed: 0,
    });
  });

  it('website reindex removes stale documents; category lookups', async () => {
    const { indexer, prisma } = setup();
    prisma.searchDocument.findMany.mockResolvedValue([
      { storeId: 's1', localeCode: 'en-US', entityId: 'old' },
    ]);
    expect(await indexer.reindexWebsite('w')).toEqual({
      products: 1,
      stale: 1,
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'p1' }]);
    expect(await indexer.productsWithCategory(['c'])).toEqual(['p1']);
    expect(await indexer.productsWithCategory([])).toEqual([]);
  });
});

describe('SearchService', () => {
  const ctx = {
    storeId: 's1',
    storeCode: 'main',
    websiteId: 'w',
    websiteCode: 'w',
    localeCode: 'en-US',
    localeChain: ['en-US'],
    currencyCode: 'USD',
    countryCode: 'US',
    pricesIncludeTax: false,
  };
  function setup(active: object = { provider: 'POSTGRES', generation: 0 }) {
    const result = {
      ids: ['p1'],
      total: 1,
      facets: {
        color: { red: 1, blue: 2 },
        category: { c: 1, hidden: 1 },
        eco: { true: 1 },
      },
      priceRange: { min: 1, max: 9 },
    };
    const postgres = {
      kind: 'POSTGRES',
      query: vi.fn(async () => result),
      suggest: vi.fn(async () => [{ id: 'p1', name: 'Tee' }]),
    };
    const meili = {
      kind: 'MEILISEARCH',
      query: vi.fn(async () => result),
      suggest: vi.fn(async () => [{ id: 'p1', name: 'Tee' }]),
    };
    const providers = { postgres, for: vi.fn(() => meili) };
    const settings = {
      effective: vi.fn(async () => ({ prefix: 'shop', synonyms: [], active })),
    };
    const attr = (
      code: string,
      type: string,
      position: number,
      options: Record<string, string> = {},
    ) => [
      code,
      {
        def: { code, type, position },
        label: code.toUpperCase(),
        options: new Map(
          Object.entries(options).map(([k, l], i) => [
            k,
            { label: l, swatch: null, position: i },
          ]),
        ),
      },
    ];
    const attributes = {
      searchCodes: vi.fn(async () => ({
        filterable: ['color', 'eco'],
        searchable: [],
      })),
      localized: vi.fn(
        async () =>
          new Map([
            attr('color', 'SELECT', 1, { red: 'Red', blue: 'Blue' }),
            attr('eco', 'BOOLEAN', 0),
          ] as never),
      ),
    };
    const categories = {
      visible: vi.fn(
        async () => new Map([['c', { name: 'Cat', parentId: null }]]),
      ),
    };
    const storefront = { cards: vi.fn(async () => [{ id: 'p1' }]) };
    const stores = {
      snapshot: vi.fn(async () => ({
        byId: new Map([['s1', { defaultCurrencyCode: 'USD' }]]),
      })),
    };
    const urls = {
      canonicalPaths: vi.fn(async () => new Map([['p1', 'tee']])),
    };
    const svc = new SearchService(
      settings as never,
      providers as never,
      attributes as never,
      categories as never,
      storefront as never,
      stores as never,
      urls as never,
    );
    return { svc, postgres, meili };
  }
  const q = (o: object = {}) =>
    ({
      q: 'tee',
      sort: 'relevance',
      page: 1,
      limit: 24,
      filter: ['color:red'],
      ...o,
    }) as never;

  it('composes cards, labelled facets (ordered, selected) and visible categories', async () => {
    const { svc } = setup();
    const engines: string[] = [];
    const r = await svc.search(ctx, q(), (e) => engines.push(e));
    expect(engines).toEqual(['POSTGRES']);
    expect(r.facets.map((f) => f.code)).toEqual(['eco', 'color']);
    expect(r.facets[1].values).toEqual([
      { value: 'red', label: 'Red', count: 1, swatch: null, selected: true },
      { value: 'blue', label: 'Blue', count: 2, swatch: null, selected: false },
    ]);
    expect(r.facets[0].values[0].label).toBe('Yes');
    expect(r.categories).toEqual([
      { id: 'c', name: 'Cat', parentId: null, count: 1 },
    ]);
    expect(r.priceRange).toEqual({ min: 1, max: 9, currency: 'USD' });
    await expect(svc.search(ctx, q({ filter: ['size:m'] }))).rejects.toThrow(
      'Not filterable: size',
    );
    await expect(
      svc.search(ctx, q({ priceMin: 5, priceMax: 1 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await svc.suggest(ctx, { q: 'te', limit: 5 })).toEqual([
      { id: 'p1', name: 'Tee', urlPath: 'tee' },
    ]);
  });

  it('external engine failures fall back to Postgres and open the breaker', async () => {
    const { svc, meili, postgres } = setup({
      provider: 'MEILISEARCH',
      connection: { url: 'm' },
      generation: 1,
    });
    const engines: string[] = [];
    await svc.search(ctx, q(), (e) => engines.push(e));
    meili.query.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 4; i++)
      await svc.search(ctx, q(), (e) => engines.push(e));
    expect(engines).toEqual([
      'MEILISEARCH',
      'POSTGRES-FALLBACK',
      'POSTGRES-FALLBACK',
      'POSTGRES-FALLBACK',
      'POSTGRES-FALLBACK',
    ]);
    expect(meili.query.mock.calls.length).toBeLessThan(
      postgres.query.mock.calls.length + 3,
    ); // breaker skipped the engine
  });

  it('circuit breaker opens after repeated failures and closes after the cool-down', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.failure('k', 1000);
    expect(b.isOpen('k', 2000)).toBe(true);
    expect(b.isOpen('k', 40_000)).toBe(false);
    b.success('k');
    expect(b.isOpen('k', 2000)).toBe(false);
  });
});

describe('search jobs, listener and controllers', () => {
  it('listener queues indexing work from catalog, price, stock, category and store events', async () => {
    const queue = {
      add: vi.fn(async (_n: string, _d: object, _o?: object) => undefined),
    };
    const r = redis();
    const products = {
      productIdsOfVariants: vi.fn(async (ids: string[]) =>
        ids.length ? ['p2'] : [],
      ),
      productIdsInCategories: vi.fn(async () => ['p3']),
    };
    const categories = { subtreeIds: vi.fn(async () => ['c', 'c2']) };
    const indexer = { productsWithCategory: vi.fn(async () => ['p4']) };
    const engines = { push: vi.fn(async () => undefined) };
    const settings = { invalidate: vi.fn(async () => undefined) };
    const l = new SearchListener(
      queue as never,
      r as never,
      products as never,
      categories as never,
      storesQuery() as never,
      indexer as never,
      engines as never,
      settings as never,
    );
    await l.onProduct({ data: { productId: 'p1' } } as never);
    await l.onVariants({ data: { variantIds: ['v'] } } as never);
    await l.onVariants({ data: {} } as never);
    await l.onCategory({ data: { categoryId: 'c', path: 'c' } } as never);
    await l.indexProducts(Array.from({ length: 450 }, (_, i) => `x${i}`));
    expect(
      queue.add.mock.calls
        .filter((c) => c[0] === 'search-index-products')
        .map((c) => (c[1] as { productIds: string[] }).productIds.length),
    ).toEqual([1, 1, 2, 200, 200, 50]);
    await l.onAttribute();
    await l.onStore({ data: { websiteId: 'w' } } as never);
    await l.onWebsite({ entityId: 'w' } as never);
    expect(
      queue.add.mock.calls
        .filter((c) => c[0] === 'search-reindex-website')
        .map((c) => c[1]),
    ).toEqual([
      { websiteId: 'w', generation: 1 },
      { websiteId: 'w', generation: 2 },
      { websiteId: 'w', generation: 3 },
    ]);
    await l.onDocuments({
      data: {
        storeId: 's1',
        localeCode: 'en-US',
        upserted: ['a'],
        removed: [],
      },
    } as never);
    expect(engines.push).toHaveBeenCalledWith('s1', 'en-US', ['a'], []);
    await l.onSettings({} as never);
    expect(settings.invalidate).toHaveBeenCalled();
  });

  it('processor dispatches jobs and skips superseded reindexes', async () => {
    const indexer = {
      indexProducts: vi.fn(async () => 'indexed'),
      reindexWebsite: vi.fn(async () => 'reindexed'),
    };
    const engines = {
      switch: vi.fn(async () => 'switched'),
      drop: vi.fn(async () => 2),
    };
    const r = redis();
    r.kv['search:reindex-generation:w'] = '3';
    const p = new SearchProcessor(
      indexer as never,
      engines as never,
      r as never,
    );
    const job = (name: string, data: object) =>
      ({ id: '1', name, data }) as never;
    expect(
      await p.process(job('search-index-products', { productIds: ['a'] })),
    ).toBe('indexed');
    expect(
      await p.process(
        job('search-reindex-website', { websiteId: 'w', generation: 2 }),
      ),
    ).toEqual({ skipped: 'superseded by a newer reindex' });
    expect(
      await p.process(
        job('search-reindex-website', { websiteId: 'w', generation: 3 }),
      ),
    ).toBe('reindexed');
    expect(
      await p.process(job('search-switch', { websiteId: 'w', generation: 1 })),
    ).toBe('switched');
    expect(
      await p.process(job('search-drop-indexes', { targets: [] })),
    ).toEqual({ dropped: 2 });
    expect(await p.process(job('x', {}))).toEqual({ skipped: 'unknown job x' });
  });

  it('controllers delegate and report the engine', async () => {
    const search = {
      search: vi.fn(
        async (_c: unknown, _q: unknown, onEngine: (k: string) => void) => (
          onEngine('POSTGRES'),
          'r'
        ),
      ),
      suggest: vi.fn(async () => 's'),
    };
    const headers: Record<string, string> = {};
    const sc = new StorefrontSearchController(search as never);
    expect(
      await sc.query(
        {} as never,
        {} as never,
        { setHeader: (k: string, v: string) => (headers[k] = v) } as never,
      ),
    ).toBe('r');
    expect(headers['X-Search-Engine']).toBe('POSTGRES');
    expect(await sc.suggest({} as never, {} as never)).toBe('s');
    const settings = {
      status: vi.fn(async () => 'st'),
      update: vi.fn(async () => 'up'),
      reindex: vi.fn(async () => undefined),
    };
    const ac = new SearchAdminController(settings as never);
    expect(await ac.status('w')).toBe('st');
    expect(await ac.update('w', {} as never, ROOT)).toBe('up');
    expect(await ac.reindex('w')).toEqual({ queued: true });
  });
});
