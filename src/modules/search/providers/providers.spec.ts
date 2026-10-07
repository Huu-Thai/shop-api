import { fakePrisma } from '../../../testing/fake-prisma.js';
import type { EngineQuery, SearchFilters } from '../search.types.js';
import { stemmerFor } from './analysis.js';
import {
  ElasticLikeProvider,
  elasticFilters,
  elasticIndexBody,
  elasticTextQuery,
} from './elastic.provider.js';
import { EngineHttp, SearchEngineError } from './http.js';
import { MeiliProvider, meiliFilter, meiliSettings } from './meili.provider.js';
import {
  filterSql,
  PostgresSearchProvider,
  prefixQuery,
} from './postgres.provider.js';
import { SearchProviders } from './registry.js';

const target = {
  storeId: 's',
  storeCode: 'main',
  localeCode: 'en-US',
  index: 'shop_g1_main_en-us',
};
const filters: SearchFilters = {
  categoryId: 'c',
  facets: { color: ['red', 'blue'], size: [] },
  priceMin: 100,
  priceMax: 900,
  inStock: true,
  visibility: ['CATALOG_SEARCH'],
};
const query = (o: Partial<EngineQuery> = {}): EngineQuery => ({
  text: 'tee',
  filters,
  sort: 'relevance',
  offset: 10,
  limit: 5,
  facetCodes: ['color'],
  categoryFacet: true,
  priceStats: true,
  ...o,
});

/** Scripted fetch: each call takes the next response (status, body) and records the request. */
function scriptedFetch(responses: [number, unknown][]) {
  const calls: {
    url: string;
    method: string;
    body?: string;
    headers: Record<string, string>;
  }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body as string | undefined,
      headers: init.headers as Record<string, string>,
    });
    const [status, body] = responses.shift() ?? [200, {}];
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('EngineHttp', () => {
  it('sends JSON with auth, accepts listed statuses, hides nothing but the origin on network errors', async () => {
    const f = scriptedFetch([
      [200, { ok: 1 }],
      [404, { missing: true }],
      [500, 'boom'],
    ]);
    const http = new EngineHttp(
      { url: 'http://e:1/' },
      () => ({ authorization: 'k' }),
      f.fn,
    );
    expect(await http.request('/a', { body: { x: 1 } })).toEqual({ ok: 1 });
    expect(f.calls[0]).toMatchObject({
      url: 'http://e:1/a',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'k' },
    });
    expect(await http.request('/b', { method: 'DELETE', ok: [404] })).toEqual({
      missing: true,
    });
    await expect(http.request('/c')).rejects.toThrow('failed (500)');
    const down = new EngineHttp(
      { url: 'http://user:secret@e:1' },
      () => ({}),
      (async () => Promise.reject(new Error('ECONNREFUSED'))) as never,
    );
    const err = await down
      .request('/x')
      .catch((e: SearchEngineError) => e.message);
    expect(err).toContain('ECONNREFUSED');
    expect(err).not.toContain('secret');
  });
});

describe('Postgres engine', () => {
  it('builds prefix tsqueries with synonyms and JSONB filters', () => {
    expect(prefixQuery('Áo thun')).toBe('ao & thun:*');
    expect(prefixQuery('  ')).toBeNull();
    expect(prefixQuery('singlet red', [['tee', 'singlet'], ['x']])).toBe(
      '(singlet | tee) & red:*',
    );
    expect(prefixQuery('tee', [['tee', 't-shirt']])).toBe(
      '(tee:* | t | shirt)',
    );
    expect(filterSql(filters)).toHaveLength(6);
    expect(filterSql(filters, 'color', true)).toHaveLength(3);
  });

  it('queries documents, counts facets and price stats, suggests', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('OVER ()')) return [{ id: 'a', total: 3n }];
        if (sql.includes('jsonb_array_elements_text'))
          return [{ v: 'red', n: 2n }];
        if (sql.includes('min((d.document')) return [{ min: 100n, max: 900n }];
        if (sql.includes('count(*) AS n')) return [{ n: 7n }];
        if (sql.includes("->>'name' AS name"))
          return [{ id: 'a', name: 'Tee' }];
        return [{ '?column?': 1 }];
      },
    );
    const p = new PostgresSearchProvider(prisma as never);
    for (const sort of [
      'relevance',
      'price_asc',
      'price_desc',
      'name',
      'newest',
    ] as const) {
      const r = await p.query(target, query({ sort }));
      expect(r).toEqual({
        ids: ['a'],
        total: 3,
        facets: { color: { red: 2 }, category: { red: 2 } },
        priceRange: { min: 100, max: 900 },
      });
    }
    expect(
      (
        await p.query(
          target,
          query({
            text: '',
            limit: 0,
            priceStats: false,
            facetCodes: [],
            categoryFacet: false,
          }),
        )
      ).total,
    ).toBe(7);
    expect(await p.suggest(target, 'te', ['CATALOG_SEARCH'], 5)).toEqual([
      { id: 'a', name: 'Tee' },
    ]);
    expect(await p.suggest(target, ' ', ['CATALOG_SEARCH'], 5)).toEqual([]);
    await p.health();
    await p.createIndex();
    await p.index(target, []);
    await p.remove();
    await p.dropIndex();
  });
});

describe('Elasticsearch / OpenSearch engine', () => {
  it('index settings: stemming by locale, synonyms, stopwords, keyword facets', () => {
    expect(stemmerFor('de-DE')).toBe('german');
    expect(stemmerFor('vi-VN')).toBeUndefined();
    const body = elasticIndexBody({
      localeCode: 'en-US',
      synonyms: [['tee', 'shirt']],
      stopwords: ['the'],
    }) as {
      settings: {
        analysis: {
          filter: Record<string, unknown>;
          analyzer: Record<string, { filter: string[] }>;
        };
      };
    };
    expect(Object.keys(body.settings.analysis.filter).sort()).toEqual([
      'shop_edge',
      'shop_stemmer',
      'shop_stop',
      'shop_synonyms',
    ]);
    expect(body.settings.analysis.analyzer.shop_search.filter).toEqual([
      'lowercase',
      'asciifolding',
      'shop_synonyms',
      'shop_stop',
      'shop_stemmer',
    ]);
    const vi = elasticIndexBody({
      localeCode: 'vi-VN',
      synonyms: [],
      stopwords: [],
    }) as typeof body;
    expect(vi.settings.analysis.analyzer.shop_index.filter).toEqual([
      'lowercase',
      'asciifolding',
    ]);
  });

  it('filters and text queries', () => {
    expect(elasticFilters(filters)).toEqual([
      { terms: { visibility: ['CATALOG_SEARCH'] } },
      { term: { categoryIds: 'c' } },
      { terms: { 'facets.color': ['red', 'blue'] } },
      { range: { price: { gte: 100, lte: 900 } } },
      { term: { inStock: true } },
    ]);
    expect(elasticFilters(filters, 'color', true)).toHaveLength(3);
    expect(elasticTextQuery(' ')).toEqual({ match_all: {} });
    expect(JSON.stringify(elasticTextQuery('tee-red'))).toContain('TEE-RED');
  });

  it('talks the REST API (create, bulk, remove, search with aggs, suggest, drop)', async () => {
    const f = scriptedFetch([
      [404, {}],
      [200, { acknowledged: true }],
      [200, { errors: false, items: [] }],
      [
        200,
        { errors: true, items: [{ index: { error: { reason: 'mapping' } } }] },
      ],
      [200, {}],
      [
        200,
        {
          hits: { total: { value: 12 }, hits: [{ _id: 'a' }, { _id: 'b' }] },
          aggregations: {
            f_color: { buckets: [{ key: 'red', doc_count: 3 }] },
            f_category: { buckets: [] },
            price: { min: 100, max: 500 },
          },
        },
      ],
      [
        200,
        {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: { price: { min: null, max: null } },
        },
      ],
      [200, { hits: { hits: [{ _id: 'a', _source: { name: 'Tee' } }] } }],
      [200, {}],
      [200, { status: 'green' }],
    ]);
    const p = new ElasticLikeProvider(
      'OPENSEARCH',
      { url: 'http://os', username: 'u', password: 'p' },
      f.fn,
    );
    await p.createIndex(target, {
      localeCode: 'en-US',
      synonyms: [],
      stopwords: [],
    });
    await p.index(target, [{ id: 'a' } as never], true);
    await expect(p.index(target, [{ id: 'b' } as never])).rejects.toThrow(
      'mapping',
    );
    await p.remove(target, ['a']);
    const r = await p.query(target, query({ sort: 'price_asc' }));
    expect(r).toEqual({
      ids: ['a', 'b'],
      total: 12,
      facets: { color: { red: 3 } },
      priceRange: { min: 100, max: 500 },
    });
    const searchBody = JSON.parse(f.calls[5].body!);
    expect(searchBody).toMatchObject({
      from: 10,
      size: 5,
      track_total_hits: true,
      sort: [{ price: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
    });
    expect(Object.keys(searchBody.aggs)).toEqual([
      'f_color',
      'f_category',
      'price',
    ]);
    expect((await p.query(target, query({ text: '' }))).priceRange).toBeNull();
    expect(JSON.parse(f.calls[6].body!).sort).toEqual([
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
    expect(await p.suggest(target, 'te', ['SEARCH'], 3)).toEqual([
      { id: 'a', name: 'Tee' },
    ]);
    expect(await p.suggest(target, '', ['SEARCH'], 3)).toEqual([]);
    await p.dropIndex(target);
    await p.health();
    expect(f.calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
    expect(f.calls[2].url).toBe('http://os/_bulk?refresh=wait_for');
    await p.index(target, []);
    await p.remove(target, []);
    const keyed = scriptedFetch([[200, {}]]);
    await new ElasticLikeProvider(
      'ELASTICSEARCH',
      { url: 'http://es', apiKey: 'abc' },
      keyed.fn,
    ).health();
    expect(keyed.calls[0].headers.authorization).toBe('ApiKey abc');
  });
});

describe('Meilisearch engine', () => {
  it('settings and filter expressions', () => {
    expect(
      meiliSettings({
        localeCode: 'en',
        synonyms: [['tee', 'shirt', 'top']],
        stopwords: ['a'],
      }),
    ).toMatchObject({
      synonyms: {
        tee: ['shirt', 'top'],
        shirt: ['tee', 'top'],
        top: ['tee', 'shirt'],
      },
      stopWords: ['a'],
      filterableAttributes: expect.arrayContaining(['facets', 'price']),
    });
    expect(meiliFilter(filters)).toEqual([
      'visibility IN ["CATALOG_SEARCH"]',
      'categoryIds = "c"',
      'facets.color IN ["red", "blue"]',
      'price >= 100',
      'price <= 900',
      'inStock = true',
    ]);
    expect(meiliFilter(filters, 'color', true)).toHaveLength(3);
  });

  it('waits for tasks (tolerating a missing index on recreate) and maps search responses', async () => {
    const f = scriptedFetch([
      [202, { taskUid: 1 }],
      [200, { status: 'processing' }],
      [
        200,
        {
          status: 'failed',
          error: { code: 'index_not_found', message: 'nope' },
        },
      ],
      [202, { taskUid: 2 }],
      [200, { status: 'succeeded' }],
      [202, { taskUid: 3 }],
      [200, { status: 'succeeded' }],
      [202, { taskUid: 4 }],
      [
        200,
        {
          status: 'failed',
          error: { code: 'invalid_document', message: 'bad doc' },
        },
      ],
      [202, { taskUid: 5 }],
      [
        200,
        {
          hits: [{ id: 'a' }],
          totalHits: 4,
          facetDistribution: {
            'facets.color': { red: 2 },
            categoryIds: { c: 1 },
            price: { 100: 1 },
            'facets.size': {},
          },
          facetStats: { price: { min: 100, max: 400 } },
        },
      ],
      [200, { hits: [], totalHits: 0 }],
      [200, { hits: [{ id: 'a', name: 'Tee' }] }],
      [202, { taskUid: 6 }],
      [404, {}],
      [200, { status: 'available' }],
      [200, { results: [] }],
    ]);
    const p = new MeiliProvider({ url: 'http://m', apiKey: 'key' }, f.fn, 1);
    await p.createIndex(target, {
      localeCode: 'en',
      synonyms: [],
      stopwords: [],
    });
    await expect(p.index(target, [{ id: 'a' } as never], true)).rejects.toThrow(
      'bad doc',
    );
    await p.index(target, [{ id: 'b' } as never]);
    const r = await p.query(target, query({ sort: 'name' }));
    expect(r).toEqual({
      ids: ['a'],
      total: 4,
      facets: { color: { red: 2 }, category: { c: 1 } },
      priceRange: { min: 100, max: 400 },
    });
    const body = JSON.parse(f.calls[10].body!);
    expect(body).toMatchObject({
      q: 'tee',
      page: 3,
      hitsPerPage: 5,
      sort: ['nameSort:asc'],
      facets: ['facets.color', 'categoryIds', 'price'],
    });
    expect(
      await p.query(
        target,
        query({
          text: '',
          limit: 0,
          facetCodes: [],
          categoryFacet: false,
          priceStats: false,
        }),
      ),
    ).toEqual({ ids: [], total: 0, facets: {}, priceRange: null });
    expect(JSON.parse(f.calls[11].body!).sort).toEqual(['createdAt:desc']);
    expect(await p.suggest(target, 'te', ['SEARCH'], 3)).toEqual([
      { id: 'a', name: 'Tee' },
    ]);
    expect(await p.suggest(target, '', ['SEARCH'], 3)).toEqual([]);
    await p.remove(target, ['a']);
    await p.remove(target, []);
    await p.dropIndex(target);
    await p.health();
    expect(f.calls[0].headers.authorization).toBe('Bearer key');
    await p.index(target, []);
  });

  it('task timeouts surface as engine errors', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Every task poll reports "enqueued" and moves the clock a minute on.
    const fetchFn = (async (url: string) => {
      if (url.includes('/tasks/')) vi.setSystemTime(Date.now() + 61_000);
      return new Response(
        JSON.stringify(
          url.includes('/tasks/') ? { status: 'enqueued' } : { taskUid: 9 },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new MeiliProvider({ url: 'http://m' }, fetchFn, 1);
    await expect(p.index(target, [{ id: 'a' } as never], true)).rejects.toThrow(
      'did not finish in time',
    );
    vi.useRealTimers();
  });
});

describe('Meilisearch index creation', () => {
  it('accepts an index a concurrent or retried build already created', async () => {
    const f = scriptedFetch([
      [404, {}], // nothing to drop
      [202, { taskUid: 1 }],
      [
        200,
        {
          status: 'failed',
          error: { code: 'index_already_exists', message: 'exists' },
        },
      ],
      [202, { taskUid: 2 }],
      [200, { status: 'succeeded' }],
    ]);
    const p = new MeiliProvider({ url: 'http://m', apiKey: 'key' }, f.fn, 1);
    await expect(
      p.createIndex(target, { localeCode: 'en', synonyms: [], stopwords: [] }),
    ).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.method ?? 'GET')).toEqual([
      'DELETE',
      'POST',
      'GET',
      'PATCH',
      'GET',
    ]);
  });
});

describe('SearchProviders', () => {
  it('returns the Postgres engine or cached external clients; needs a connection', () => {
    const pg = {} as PostgresSearchProvider;
    const r = new SearchProviders(pg);
    expect(r.for({ provider: 'POSTGRES' })).toBe(pg);
    const m = r.for({
      provider: 'MEILISEARCH',
      connection: { url: 'http://m' },
    });
    expect(
      r.for({ provider: 'MEILISEARCH', connection: { url: 'http://m' } }),
    ).toBe(m);
    expect(
      r.for({ provider: 'OPENSEARCH', connection: { url: 'http://o' } }).kind,
    ).toBe('OPENSEARCH');
    expect(() => r.for({ provider: 'ELASTICSEARCH' })).toThrow(
      'no usable connection',
    );
  });
});
