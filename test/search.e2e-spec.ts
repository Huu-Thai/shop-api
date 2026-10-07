/**
 * Phase 3 "done": storefront search works on Postgres; switching to Meilisearch reindexes without
 * downtime. The same behaviour suite runs against both engines. Real API + worker, Postgres,
 * Redis (password), MinIO and Meilisearch (Testcontainers).
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import request from 'supertest';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MEILI_KEY = 'e2e-meili-master-key-0123456789';

describe('Search (e2e)', () => {
  let stack: TestStack;
  let meili: StartedTestContainer;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let token: string;
  const id: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const admin = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) => {
    const r = http()
      [method](`/api/v1/admin${path}`)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  };
  const search = (query: string, lang = 'en') =>
    http()
      .get(`/api/v1/store/search?${query}`)
      .set('x-store', 'main')
      .set('accept-language', lang)
      .then((r) => {
        if (r.status !== 200)
          throw new Error(
            `search ${query} → ${r.status} ${JSON.stringify(r.body)}`,
          );
        if (r.headers['x-search-engine'] !== expectedEngine)
          throw new Error(
            `search ${query} answered by ${r.headers['x-search-engine']}, expected ${expectedEngine}`,
          );
        return r.body as Body;
      });
  /** Engine every search in the current block must be answered by (X-Search-Engine). */
  let expectedEngine = 'POSTGRES';
  const names = (b: Body) => (b.data as Body[]).map((c) => c.name);
  const status = () =>
    admin('get', `/search/websites/${id.website}`).then((r) => r.body as Body);

  beforeAll(async () => {
    [stack, meili] = await Promise.all([
      startStack(),
      new GenericContainer('getmeili/meilisearch:v1.13')
        .withEnvironment({
          MEILI_MASTER_KEY: MEILI_KEY,
          MEILI_NO_ANALYTICS: 'true',
        })
        .withExposedPorts(7700)
        .withWaitStrategy(Wait.forHttp('/health', 7700))
        .start(),
    ]);
    app = await startApp();
    worker = await startWorker(['search-index', 'price-index', 'inventory']);
    token = await rootToken(app);

    await admin('patch', '/locales/vi-VN', { isActive: true }).expect(200);
    id.website = (
      await admin('post', '/websites', {
        code: 'shop',
        name: 'Shop',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    await admin('post', '/stores', {
      websiteId: id.website,
      code: 'main',
      name: 'Main',
      defaultLocaleCode: 'en-US',
      localeCodes: ['vi-VN'],
      defaultCurrencyCode: 'USD',
      countryCode: 'US',
    }).expect(201);
    const labels = (en: string, vi: string) => [
      { localeCode: 'en-US', label: en },
      { localeCode: 'vi-VN', label: vi },
    ];
    await admin('post', '/attributes', {
      code: 'color',
      type: 'SELECT',
      isFilterable: true,
      isSearchable: true,
      labels: labels('Colour', 'Màu'),
      options: [
        { code: 'red', swatch: '#d32f2f', labels: labels('Red', 'Đỏ') },
        { code: 'blue', labels: labels('Blue', 'Xanh') },
      ],
    }).expect(201);
    await admin('post', '/attributes', {
      code: 'size',
      type: 'SELECT',
      isFilterable: true,
      labels: labels('Size', 'Cỡ'),
      options: ['s', 'm'].map((c) => ({
        code: c,
        labels: labels(c.toUpperCase(), c.toUpperCase()),
      })),
    }).expect(201);
    await admin('post', '/attributes', {
      code: 'material',
      type: 'TEXT',
      isSearchable: true,
      labels: labels('Material', 'Chất liệu'),
    }).expect(201);
    const set = (
      await admin('post', '/attribute-sets', {
        code: 'apparel',
        name: 'Apparel',
        attributes: [{ code: 'color' }, { code: 'size' }, { code: 'material' }],
      }).expect(201)
    ).body.id;
    const cat = async (en: string, vi: string, parentId?: string) =>
      (
        await admin('post', '/categories', {
          parentId,
          translations: [
            { localeCode: 'en-US', name: en },
            { localeCode: 'vi-VN', name: vi },
          ],
          websiteIds: [id.website],
        }).expect(201)
      ).body.id as string;
    id.men = await cat('Men', 'Nam');
    id.tees = await cat('Tops', 'Áo', id.men);
    id.acc = await cat('Accessories', 'Phụ kiện');
    const product = async (body: object) =>
      (
        await admin('post', '/products', {
          attributeSetId: set,
          websiteIds: [id.website],
          ...body,
        }).expect(201)
      ).body;
    const tee = await product({
      sku: 'TEE',
      type: 'CONFIGURABLE',
      attributes: { material: 'Organic cotton' },
      translations: [
        {
          localeCode: 'en-US',
          name: 'Classic Tee',
          shortDescription: '<p>A <b>soft</b> everyday tee</p>',
        },
        { localeCode: 'vi-VN', name: 'Áo thun cổ điển' },
      ],
      categories: [{ categoryId: id.tees }],
      configurableAttributes: ['color', 'size'],
      variants: [
        { sku: 'TEE-RED-M', options: { color: 'red', size: 'm' } },
        { sku: 'TEE-BLUE-S', options: { color: 'blue', size: 's' } },
      ],
    });
    id.tee = tee.id;
    id.polo = (
      await product({
        sku: 'POLO',
        type: 'SIMPLE',
        attributes: { color: 'blue', size: 'm', material: 'Pique cotton' },
        translations: [
          { localeCode: 'en-US', name: 'Polo Shirt' },
          { localeCode: 'vi-VN', name: 'Áo polo' },
        ],
        categories: [{ categoryId: id.tees }],
      })
    ).id;
    id.socks = (
      await product({
        sku: 'SOCKS',
        type: 'SIMPLE',
        attributes: { color: 'red', material: 'Merino wool' },
        translations: [
          { localeCode: 'en-US', name: 'Wool Socks' },
          { localeCode: 'vi-VN', name: 'Tất len' },
        ],
        categories: [{ categoryId: id.acc }],
      })
    ).id;
    id.wrap = (
      await product({
        sku: 'WRAP',
        type: 'SIMPLE',
        visibility: 'CATALOG',
        translations: [{ localeCode: 'en-US', name: 'Gift wrap' }],
        categories: [{ categoryId: id.acc }],
      })
    ).id;
    await product({
      sku: 'HIDDEN',
      type: 'SIMPLE',
      visibility: 'NOT_VISIBLE',
      translations: [{ localeCode: 'en-US', name: 'Hidden tee' }],
      categories: [{ categoryId: id.tees }],
    });

    const book = (
      await admin('post', '/price-books', {
        code: 'usd',
        name: 'USD',
        currencyCode: 'USD',
        websiteId: id.website,
      }).expect(201)
    ).body.id;
    await admin('put', `/price-books/${book}/entries`, {
      entries: [
        { sku: 'TEE-RED-M', amount: 2500 },
        { sku: 'TEE-BLUE-S', amount: 2700 },
        { sku: 'POLO', amount: 3500 },
        { sku: 'SOCKS', amount: 1200 },
        { sku: 'WRAP', amount: 300 },
      ],
    }).expect(200);
    const source = (
      await admin('post', '/inventory/sources', {
        code: 'wh',
        name: 'WH',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
    await admin('put', `/websites/${id.website}/inventory-sources`, {
      sources: [{ sourceId: source }],
    }).expect(200);
    for (const sku of ['TEE-RED-M', 'TEE-BLUE-S', 'SOCKS', 'WRAP'])
      await admin('post', '/inventory/adjustments', {
        sourceId: source,
        sku,
        delta: 5,
      }).expect(200);
    id.source = source;

    // Documents arrive asynchronously (product, price-index and inventory events → search jobs).
    await eventually(
      () => search('sort=name'),
      (b) =>
        b.total === 4 &&
        (b.data as Body[]).every((c: Body) => c.price) &&
        b.data.find((c: Body) => c.sku === 'SOCKS')?.inStock,
      30_000,
    );
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await Promise.allSettled([stack?.stop(), meili?.stop()]);
  });

  /** The behaviour every engine must have (provider suite). */
  const behaviour = () => {
    it('full text with ranking, search-as-you-type and exact SKUs', async () => {
      expect(names(await search('q=tee'))[0]).toBe('Classic Tee');
      expect(names(await search('q=shirt'))).toEqual(['Polo Shirt']);
      expect(names(await search('q=cla'))).toEqual(['Classic Tee']);
      expect(names(await search('q=merino'))).toEqual(['Wool Socks']); // searchable attribute
      expect(names(await search('q=TEE-RED-M'))).toEqual(['Classic Tee']);
      expect((await search('q=zzzz')).total).toBe(0);
    });

    it('accent-insensitive search in the request locale', async () => {
      expect(names(await search('q=ao%20thun', 'vi')).sort()).toContain(
        'Áo thun cổ điển',
      );
      expect(names(await search('q=%C3%A1o', 'vi')).sort()).toEqual([
        'Áo polo',
        'Áo thun cổ điển',
      ]);
      expect(names(await search('q=tat', 'vi'))).toEqual(['Tất len']);
    });

    it('disjunctive facets keep alternatives of the selected value', async () => {
      const red = await search('filter=color:red&sort=name');
      expect(names(red)).toEqual(['Classic Tee', 'Wool Socks']);
      const color = (red.facets as Body[]).find((f) => f.code === 'color')!;
      expect(color.label).toBe('Colour');
      expect(color.values).toEqual([
        {
          value: 'red',
          label: 'Red',
          count: 2,
          swatch: '#d32f2f',
          selected: true,
        },
        {
          value: 'blue',
          label: 'Blue',
          count: 2,
          swatch: null,
          selected: false,
        },
      ]);
      const size = (red.facets as Body[]).find((f) => f.code === 'size')!;
      expect(size.values.map((v: Body) => [v.value, v.count])).toEqual([
        ['s', 1],
        ['m', 1],
      ]);
      expect(
        names(await search('filter=color:red,blue&filter=size:m&sort=name')),
      ).toEqual(['Classic Tee', 'Polo Shirt']);
    });

    it('category browsing (catalog-visible products, subcategories, category counts)', async () => {
      const men = await search(`category=${id.men}&sort=name`);
      expect(names(men)).toEqual(['Classic Tee', 'Polo Shirt']);
      expect(men.categories).toEqual(
        expect.arrayContaining([
          { id: id.men, name: 'Men', parentId: null, count: 2 },
          { id: id.tees, name: 'Tops', parentId: id.men, count: 2 },
        ]),
      );
      expect(names(await search(`category=${id.acc}&sort=name`))).toEqual([
        'Gift wrap',
        'Wool Socks',
      ]);
      expect((await search('q=gift')).total).toBe(0); // CATALOG-only products are not searchable
      expect((await search('q=hidden')).total).toBe(0);
    });

    it('price filter, range and sort; in-stock filter', async () => {
      // Browsing (no text) lists catalog-visible products, so the gift wrap appears here.
      const cheap = await search('priceMin=1000&priceMax=2600&sort=price_asc');
      expect(names(cheap)).toEqual(['Wool Socks', 'Classic Tee']);
      expect(cheap.priceRange).toEqual({
        min: 300,
        max: 3500,
        currency: 'USD',
      }); // ignores its own filter
      expect(names(await search('sort=price_desc'))).toEqual([
        'Polo Shirt',
        'Classic Tee',
        'Wool Socks',
        'Gift wrap',
      ]);
      expect(names(await search('inStock=true&sort=name'))).toEqual([
        'Classic Tee',
        'Gift wrap',
        'Wool Socks',
      ]); // polo has no stock
      expect(
        (await search('limit=1&page=2&sort=name')).data.map(
          (c: Body) => c.name,
        ),
      ).toEqual(['Gift wrap']);
    });

    it('suggestions with URLs', async () => {
      const s = (
        await http()
          .get('/api/v1/store/search/suggest?q=cla')
          .set('x-store', 'main')
          .expect(200)
      ).body;
      expect(s).toEqual([
        { id: id.tee, name: 'Classic Tee', urlPath: 'classic-tee' },
      ]);
    });
  };

  describe('on Postgres (default)', () => {
    behaviour();

    it('rejects unknown filters and inverted price ranges', async () => {
      await http()
        .get('/api/v1/store/search?filter=material:cotton')
        .set('x-store', 'main')
        .expect(400);
      await http()
        .get('/api/v1/store/search?priceMin=10&priceMax=5')
        .set('x-store', 'main')
        .expect(400);
    });
  });

  describe('switching to Meilisearch without downtime', () => {
    it('refuses unreachable engines and never exposes credentials', async () => {
      await admin('put', `/search/websites/${id.website}`, {
        provider: 'MEILISEARCH',
        connection: { url: 'http://127.0.0.1:1', apiKey: 'x' },
      }).expect(400);
      expect((await status()).active).toEqual({
        provider: 'POSTGRES',
        url: null,
        generation: 0,
      });
    });

    it('builds the new index in the background while search keeps answering', async () => {
      const url = `http://${meili.getHost()}:${meili.getMappedPort(7700)}`;
      const started = await admin('put', `/search/websites/${id.website}`, {
        provider: 'MEILISEARCH',
        connection: { url, apiKey: MEILI_KEY },
        synonyms: [['tee', 'singlet']],
      }).expect(200);
      expect(started.body).toMatchObject({
        status: 'BUILDING',
        active: { provider: 'POSTGRES' },
        pending: { provider: 'MEILISEARCH', url, generation: 1 },
      });
      expect(JSON.stringify(started.body)).not.toContain(MEILI_KEY);

      // During the build every search succeeds with full results.
      const during: number[] = [];
      const done = await eventually(
        async () => {
          during.push((await search('sort=name')).total);
          return status();
        },
        (s) => s.status !== 'BUILDING',
        60_000,
      );
      expect(done).toMatchObject({
        status: 'READY',
        active: { provider: 'MEILISEARCH', generation: 1 },
        pending: null,
      });
      expect(during.every((t) => t === 4)).toBe(true);
      // The API notices the flip within its config cache window (≤ 5 s).
      await eventually(
        () =>
          http()
            .get('/api/v1/store/search')
            .set('x-store', 'main')
            .then((r) => r.headers['x-search-engine']),
        (e) => e === 'MEILISEARCH',
        15_000,
      );
      expectedEngine = 'MEILISEARCH';

      const { PrismaService } =
        await import('../src/database/prisma.service.js');
      const row = await app
        .get(PrismaService)
        .searchSettings.findUniqueOrThrow({ where: { websiteId: id.website } });
      expect(row.connection).not.toContain(MEILI_KEY); // sealed at rest
    });

    describe('on Meilisearch', () => {
      behaviour();

      it('synonyms apply on the external engine', async () => {
        expect(names(await search('q=singlet'))).toContain('Classic Tee');
      });
    });

    it('keeps the engine current with catalog, price and stock changes', async () => {
      await admin('patch', `/products/${id.polo}`, {
        translations: [{ localeCode: 'en-US', name: 'Polo Classic' }],
      }).expect(200);
      await admin('post', '/inventory/adjustments', {
        sourceId: id.source,
        sku: 'POLO',
        delta: 2,
      }).expect(200);
      await eventually(
        () => search('q=classic&inStock=true&sort=name'),
        (b) => names(b).join() === 'Classic Tee,Polo Classic',
        30_000,
      );
    });

    it('falls back to Postgres when the engine is down', async () => {
      await meili.stop();
      expectedEngine = 'POSTGRES-FALLBACK';
      const r = await search('q=classic&sort=name');
      expect(names(r)).toEqual(['Classic Tee', 'Polo Classic']);
    });

    it('switching back to Postgres is immediate', async () => {
      await admin('put', `/search/websites/${id.website}`, {
        provider: 'POSTGRES',
      }).expect(200);
      const s = await eventually(
        status,
        (b) => b.status === 'READY' && b.active.provider === 'POSTGRES',
        30_000,
      );
      expect(s.active.generation).toBe(2);
      await eventually(
        () =>
          http()
            .get('/api/v1/store/search')
            .set('x-store', 'main')
            .then((r) => r.headers['x-search-engine']),
        (e) => e === 'POSTGRES',
        15_000,
      );
      expectedEngine = 'POSTGRES';
      expect(names(await search('q=classic&sort=name'))).toEqual([
        'Classic Tee',
        'Polo Classic',
      ]);
    });
  });
});
