/**
 * Phase 1 "done": the same catalog is sold on two websites in two locales. Real API + worker
 * against PostgreSQL, password-protected Redis and MinIO.
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Catalog on two websites (e2e)', () => {
  let stack: TestStack;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let token: string;
  const ids: Record<string, string> = {};
  const variantIds: Record<string, string> = {};

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
  const store = (code: string, path: string, lang?: string) => {
    const r = http().get(`/api/v1/store${path}`).set('x-store', code);
    return lang ? r.set('accept-language', lang) : r;
  };
  const labels = (en: string, vi: string) => [
    { localeCode: 'en-US', label: en },
    { localeCode: 'vi-VN', label: vi },
  ];

  beforeAll(async () => {
    stack = await startStack();
    app = await startApp();
    worker = await startWorker(['media', 'catalog']);
    token = await rootToken(app);

    // ── Stores: activate Vietnamese + VND, two websites, one store each.
    await admin('patch', '/locales/vi-VN', { isActive: true }).expect(200);
    await admin('patch', '/currencies/VND', { isActive: true }).expect(200);
    ids.us = (
      await admin('post', '/websites', {
        code: 'us',
        name: 'Shop US',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    ids.vn = (
      await admin('post', '/websites', {
        code: 'vn',
        name: 'Shop Việt Nam',
        baseCurrencyCode: 'VND',
      }).expect(201)
    ).body.id;
    ids.usStore = (
      await admin('post', '/stores', {
        websiteId: ids.us,
        code: 'us-en',
        name: 'US English',
        baseUrl: 'https://shop.example.com',
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
    ids.vnStore = (
      await admin('post', '/stores', {
        websiteId: ids.vn,
        code: 'vn-vi',
        name: 'Việt Nam',
        baseUrl: 'https://shop.example.vn',
        defaultLocaleCode: 'vi-VN',
        localeCodes: ['en-US'],
        defaultCurrencyCode: 'VND',
        currencyCodes: ['USD'],
        countryCode: 'VN',
        pricesIncludeTax: true,
      }).expect(201)
    ).body.id;

    // ── Attributes and an apparel set.
    const option = (code: string, en: string, vi: string, swatch?: string) => ({
      code,
      swatch,
      labels: labels(en, vi),
    });
    await admin('post', '/attributes', {
      code: 'color',
      type: 'SELECT',
      isFilterable: true,
      labels: labels('Colour', 'Màu sắc'),
      options: [
        option('red', 'Red', 'Đỏ', '#d32f2f'),
        option('blue', 'Blue', 'Xanh dương', '#1565c0'),
        option('green', 'Green', 'Xanh lá'),
      ],
    }).expect(201);
    await admin('post', '/attributes', {
      code: 'size',
      type: 'SELECT',
      isFilterable: true,
      labels: labels('Size', 'Cỡ'),
      options: [option('s', 'S', 'S'), option('m', 'M', 'M')],
    }).expect(201);
    await admin('post', '/attributes', {
      code: 'material',
      type: 'TEXT',
      labels: labels('Material', 'Chất liệu'),
    }).expect(201);
    await admin('post', '/attributes', {
      code: 'care',
      type: 'TEXTAREA',
      isLocalizable: true,
      labels: labels('Care', 'Bảo quản'),
    }).expect(201);
    ids.apparel = (
      await admin('post', '/attribute-sets', {
        code: 'apparel',
        name: 'Apparel',
        attributes: ['color', 'size', 'material', 'care'].map((code) => ({
          code,
        })),
      }).expect(201)
    ).body.id;

    // ── Categories shared by both websites.
    const both = [ids.us, ids.vn];
    ids.men = (
      await admin('post', '/categories', {
        translations: [
          { localeCode: 'en-US', name: 'Men' },
          { localeCode: 'vi-VN', name: 'Nam' },
        ],
        websiteIds: both,
      }).expect(201)
    ).body.id;
    ids.tees = (
      await admin('post', '/categories', {
        parentId: ids.men,
        translations: [
          { localeCode: 'en-US', name: 'T-Shirts' },
          { localeCode: 'vi-VN', name: 'Áo thun' },
        ],
        websiteIds: both,
      }).expect(201)
    ).body.id;

    // ── Products of every type.
    const tee = await admin('post', '/products', {
      sku: 'TEE',
      type: 'CONFIGURABLE',
      attributeSetId: ids.apparel,
      attributes: { material: 'Organic cotton' },
      translations: [
        {
          localeCode: 'en-US',
          name: 'Classic Tee',
          attributes: { care: 'Machine wash cold' },
        },
        {
          localeCode: 'vi-VN',
          name: 'Áo thun cổ điển',
          attributes: { care: 'Giặt máy nước lạnh' },
        },
      ],
      websiteIds: both,
      categories: [{ categoryId: ids.tees }],
      configurableAttributes: ['color', 'size'],
      variants: [
        { sku: 'TEE-RED-S', options: { color: 'red', size: 's' } },
        { sku: 'TEE-RED-M', options: { color: 'red', size: 'm' } },
        { sku: 'TEE-BLUE-M', options: { color: 'blue', size: 'm' } },
      ],
    }).expect(201);
    ids.tee = tee.body.id;
    for (const v of tee.body.variants) variantIds[v.sku] = v.id;

    const socks = (
      await admin('post', '/products', {
        sku: 'SOCKS',
        type: 'SIMPLE',
        attributeSetId: ids.apparel,
        attributes: { color: 'blue', size: 'm' },
        weightGrams: 80,
        translations: [{ localeCode: 'en-US', name: 'Everyday Socks' }],
        websiteIds: both,
        categories: [{ categoryId: ids.men }],
      }).expect(201)
    ).body;
    variantIds.SOCKS = socks.variants[0].id;
    ids.socks = socks.id;

    ids.wrap = (
      await admin('post', '/products', {
        sku: 'GIFT-WRAP',
        type: 'VIRTUAL',
        translations: [{ localeCode: 'en-US', name: 'Gift wrapping' }],
        websiteIds: [ids.us],
      }).expect(201)
    ).body.id;

    ids.outfit = (
      await admin('post', '/products', {
        sku: 'OUTFIT',
        type: 'BUNDLE',
        typeOptions: { priceType: 'DYNAMIC' },
        translations: [
          { localeCode: 'en-US', name: 'Weekend Outfit' },
          { localeCode: 'vi-VN', name: 'Bộ cuối tuần' },
        ],
        websiteIds: both,
        categories: [{ categoryId: ids.men }],
        bundleOptions: [
          {
            code: 'top',
            inputType: 'RADIO',
            titles: [
              { localeCode: 'en-US', title: 'Choose a tee' },
              { localeCode: 'vi-VN', title: 'Chọn áo' },
            ],
            selections: [
              { variantId: variantIds['TEE-RED-M'], isDefault: true },
              { variantId: variantIds['TEE-BLUE-M'] },
            ],
          },
          {
            code: 'socks',
            inputType: 'CHECKBOX',
            isRequired: false,
            titles: [{ localeCode: 'en-US', title: 'Add socks' }],
            selections: [{ variantId: variantIds.SOCKS, qty: 2 }],
          },
        ],
      }).expect(201)
    ).body.id;

    ids.giftCard = (
      await admin('post', '/products', {
        sku: 'GIFTCARD',
        type: 'GIFT_CARD',
        typeOptions: {
          amounts: [
            { currency: 'USD', amount: 2500 },
            { currency: 'VND', amount: 500000 },
          ],
        },
        translations: [{ localeCode: 'en-US', name: 'Gift Card' }],
        websiteIds: both,
      }).expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await stack?.stop();
  });

  describe('store resolution', () => {
    it('resolves the store from X-Store or the domain, and negotiates locale and currency', async () => {
      const vn = await store('vn-vi', '/config')
        .set('x-currency', 'USD')
        .expect(200);
      expect(vn.body).toMatchObject({
        store: { code: 'vn-vi', pricesIncludeTax: true },
        website: { code: 'vn' },
        locale: 'vi-VN',
        currency: 'USD',
      });
      expect(vn.body.locales.map((l: Body) => l.code)).toEqual([
        'vi-VN',
        'en-US',
      ]);
      const byHost = await http()
        .get('/api/v1/store/config')
        .set('host', 'shop.example.vn')
        .set('accept-language', 'en-GB,en;q=0.8')
        .expect(200);
      expect(byHost.body).toMatchObject({
        store: { code: 'vn-vi' },
        locale: 'en-US',
        currency: 'VND',
      });
      await http().get('/api/v1/store/config').expect(400);
      await store('nowhere', '/config').expect(404);
    });

    it('sends CDN caching headers and honours ETags', async () => {
      const res = await store('us-en', `/products/${ids.tee}`).expect(200);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers.vary).toContain('X-Store');
      expect(res.headers['surrogate-key']).toContain(`product:${ids.tee}`);
      await store('us-en', `/products/${ids.tee}`)
        .set('if-none-match', res.headers.etag)
        .expect(304);
    });
  });

  describe('one catalog, two websites, two locales', () => {
    it('serves localized category trees with per-locale URLs', async () => {
      const vi = (
        await eventually(
          () => store('vn-vi', '/categories'),
          (r) => r.body[0]?.children?.[0]?.urlPath === 'nam/ao-thun',
        )
      ).body;
      expect(vi[0]).toMatchObject({
        name: 'Nam',
        urlPath: 'nam',
        children: [{ name: 'Áo thun', urlPath: 'nam/ao-thun' }],
      });
      const en = (await store('vn-vi', '/categories', 'en').expect(200)).body;
      expect(en[0]).toMatchObject({
        name: 'Men',
        urlPath: 'men',
        children: [{ name: 'T-Shirts', urlPath: 'men/t-shirts' }],
      });
    });

    it('lists the same products on both websites, each in its own language', async () => {
      const vn = (
        await store(
          'vn-vi',
          `/categories/${ids.men}/products?sort=name`,
        ).expect(200)
      ).body;
      expect(vn.data.map((p: Body) => p.name)).toEqual([
        'Áo thun cổ điển',
        'Bộ cuối tuần',
        'Everyday Socks',
      ]); // socks fall back to English
      expect(vn.total).toBe(3);
      const us = (
        await store(
          'us-en',
          `/categories/${ids.men}/products?sort=name`,
        ).expect(200)
      ).body;
      expect(us.data.map((p: Body) => p.name)).toEqual([
        'Classic Tee',
        'Everyday Socks',
        'Weekend Outfit',
      ]);
      expect(us.data[0]).toMatchObject({
        sku: 'TEE',
        urlPath: 'classic-tee',
        type: 'CONFIGURABLE',
      });
    });

    it('filters by attribute options, including configurable variants', async () => {
      const red = (
        await store(
          'us-en',
          `/categories/${ids.men}/products?filter=color:red`,
        ).expect(200)
      ).body;
      expect(red.data.map((p: Body) => p.sku)).toEqual(['TEE']);
      const blueM = (
        await store(
          'us-en',
          `/categories/${ids.men}/products?filter=color:blue&filter=size:m&sort=name`,
        ).expect(200)
      ).body;
      expect(blueM.data.map((p: Body) => p.sku)).toEqual(['TEE', 'SOCKS']);
      expect(
        (
          await store(
            'us-en',
            `/categories/${ids.men}/products?filter=color:green`,
          ).expect(200)
        ).body.total,
      ).toBe(0);
      await store(
        'us-en',
        `/categories/${ids.men}/products?filter=material:cotton`,
      ).expect(400);
      expect(
        (
          await store(
            'us-en',
            `/categories/${ids.men}/products?includeSubcategories=false`,
          ).expect(200)
        ).body.total,
      ).toBe(2);
    });

    it('renders the configurable product page in Vietnamese', async () => {
      const p = (
        await store('vn-vi', '/products/by-slug/ao-thun-co-dien').expect(200)
      ).body;
      expect(p).toMatchObject({
        id: ids.tee,
        name: 'Áo thun cổ điển',
        locale: 'vi-VN',
        urlPath: 'ao-thun-co-dien',
      });
      expect(p.attributes).toEqual([
        {
          code: 'care',
          label: 'Bảo quản',
          value: 'Giặt máy nước lạnh',
          valueLabel: 'Giặt máy nước lạnh',
        },
        {
          code: 'material',
          label: 'Chất liệu',
          value: 'Organic cotton',
          valueLabel: 'Organic cotton',
        },
      ]);
      expect(p.configurableOptions).toEqual([
        {
          code: 'color',
          label: 'Màu sắc',
          values: [
            { code: 'red', label: 'Đỏ', swatch: '#d32f2f' },
            { code: 'blue', label: 'Xanh dương', swatch: '#1565c0' },
          ],
        },
        {
          code: 'size',
          label: 'Cỡ',
          values: [
            { code: 's', label: 'S', swatch: null },
            { code: 'm', label: 'M', swatch: null },
          ],
        },
      ]);
      expect(p.variants).toHaveLength(3);
      expect(p.breadcrumbs).toEqual([
        { id: ids.men, name: 'Nam', urlPath: 'nam' },
        { id: ids.tees, name: 'Áo thun', urlPath: 'nam/ao-thun' },
      ]);
    });

    it('renders bundles and gift cards for the store currency', async () => {
      const b = (await store('vn-vi', `/products/${ids.outfit}`).expect(200))
        .body;
      expect(b.bundle).toMatchObject({
        priceType: 'DYNAMIC',
        options: [
          { code: 'top', title: 'Chọn áo', inputType: 'RADIO' },
          { code: 'socks', title: 'Add socks' },
        ],
      });
      expect(
        b.bundle.options[0].selections.map((s: Body) => [
          s.sku,
          s.name,
          s.isDefault,
        ]),
      ).toEqual([
        ['TEE-RED-M', 'Áo thun cổ điển', true],
        ['TEE-BLUE-M', 'Áo thun cổ điển', false],
      ]);
      const g = (await store('vn-vi', `/products/${ids.giftCard}`).expect(200))
        .body;
      expect(g.giftCard).toMatchObject({
        cardType: 'VIRTUAL',
        amounts: [{ currency: 'VND', amount: 500000 }],
      });
      expect(g.variants).toHaveLength(1);
    });

    it('keeps website-only products off other websites', async () => {
      await store('us-en', `/products/${ids.wrap}`).expect(200);
      await store('vn-vi', `/products/${ids.wrap}`).expect(404);
    });

    it('a store override hides a product in one store only', async () => {
      await admin('put', `/products/${ids.socks}/stores/${ids.vnStore}`, {
        status: 'DISABLED',
      }).expect(200);
      await store('vn-vi', `/products/${ids.socks}`).expect(404);
      await store('us-en', `/products/${ids.socks}`).expect(200);
      const b = (await store('vn-vi', `/products/${ids.outfit}`).expect(200))
        .body;
      expect(b.bundle.options.map((o: Body) => o.code)).toEqual(['top']); // socks can't be sold there
      await admin(
        'delete',
        `/products/${ids.socks}/stores/${ids.vnStore}`,
      ).expect(204);
      await store('vn-vi', `/products/${ids.socks}`).expect(200);
    });
  });

  describe('URLs', () => {
    it('resolves paths per store and locale', async () => {
      expect(
        (await store('vn-vi', '/url-resolver?path=/nam/ao-thun').expect(200))
          .body,
      ).toMatchObject({ type: 'CATEGORY', id: ids.tees, redirectStatus: null });
      expect(
        (
          await store('vn-vi', '/url-resolver?path=/classic-tee', 'en').expect(
            200,
          )
        ).body,
      ).toMatchObject({ type: 'PRODUCT', id: ids.tee });
      await store('us-en', '/url-resolver?path=/nam/ao-thun').expect(404);
    });

    it('a renamed slug leaves a 301 from the old URL', async () => {
      await admin('patch', `/products/${ids.tee}`, {
        translations: [
          {
            localeCode: 'en-US',
            name: 'Classic Tee',
            slug: 'classic-crew-tee',
          },
        ],
      }).expect(200);
      const old = await eventually(
        () =>
          store('us-en', '/url-resolver?path=/classic-tee').then((r) => r.body),
        (b) => b.redirectStatus === 301,
      );
      expect(old).toMatchObject({
        type: 'PRODUCT',
        id: ids.tee,
        redirectStatus: 301,
        location: '/classic-crew-tee',
        canonicalPath: 'classic-crew-tee',
      });
    });

    it('moving a category rebuilds its subtree’s URLs and redirects the old ones', async () => {
      await admin('post', `/categories/${ids.tees}/move`, {
        parentId: null,
      }).expect(200);
      const moved = await eventually(
        () =>
          store('us-en', '/url-resolver?path=/men/t-shirts').then(
            (r) => r.body,
          ),
        (b) => b.redirectStatus === 301,
      );
      expect(moved).toMatchObject({
        type: 'CATEGORY',
        id: ids.tees,
        location: '/t-shirts',
      });
      await admin('post', `/categories/${ids.tees}/move`, {
        parentId: ids.men,
      }).expect(200);
      await eventually(
        () =>
          store('us-en', '/url-resolver?path=/men/t-shirts').then(
            (r) => r.body,
          ),
        (b) => b.redirectStatus === null,
      );
    });

    it('moving to a position inserts there and renumbers the siblings', async () => {
      const kids = async () =>
        (await admin('get', '/categories').expect(200)).body
          .filter((c: { parentId: string | null }) => c.parentId === ids.men)
          .sort(
            (a: { position: number }, b: { position: number }) =>
              a.position - b.position,
          )
          .map((c: { id: string; position: number }) => [c.id, c.position]);
      const extra = await admin('post', '/categories', {
        parentId: ids.men,
        translations: [{ localeCode: 'en-US', name: 'Hoodies' }],
      }).expect(201);
      const before = await kids();
      expect(before.length).toBeGreaterThanOrEqual(2);
      await admin('post', `/categories/${extra.body.id}/move`, {
        parentId: ids.men,
        position: 0,
      }).expect(200);
      const after = await kids();
      expect(after[0]).toEqual([extra.body.id, 0]);
      expect(after.map((k: [string, number]) => k[1])).toEqual(
        after.map((_: unknown, i: number) => i),
      );
      await admin('delete', `/categories/${extra.body.id}`).expect(204);
    });

    it('vetoes slugs that would take another page’s URL', async () => {
      const res = await admin('post', '/products', {
        sku: 'MEN',
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name: 'Men' }],
        websiteIds: [ids.us],
      }).expect(409);
      expect(JSON.stringify(res.body.message)).toContain('/men');
    });

    it('custom redirects', async () => {
      await admin('post', '/url-rewrites', {
        storeId: ids.usStore,
        localeCode: 'en-US',
        requestPath: '/Summer-Sale',
        targetPath: '/men',
      }).expect(201);
      expect(
        (await store('us-en', '/url-resolver?path=/summer-sale').expect(200))
          .body,
      ).toMatchObject({
        type: 'CUSTOM',
        redirectStatus: 301,
        location: '/men',
      });
    });
  });

  describe('integrity across modules', () => {
    it('refuses to remove attribute options that products use (products module veto)', async () => {
      const attrs = (await admin('get', '/attributes').expect(200))
        .body as Body[];
      const color = attrs.find((a) => a.code === 'color')!;
      const res = await admin('patch', `/attributes/${color.id}`, {
        options: color.options.filter((o: Body) => o.code !== 'red'),
      }).expect(409);
      expect(JSON.stringify(res.body.message)).toContain('red');
      await admin('patch', `/attributes/${color.id}`, {
        options: color.options.filter((o: Body) => o.code !== 'green'),
      }).expect(200);
    });

    it('searches variants by SKU and product name for admin pickers', async () => {
      const bySku = (await admin('get', '/variants?search=tee-red').expect(200))
        .body;
      expect(bySku.map((v: { sku: string }) => v.sku).sort()).toEqual([
        'TEE-RED-M',
        'TEE-RED-S',
      ]);
      expect(bySku[0]).toMatchObject({
        productId: ids.tee,
        productSku: 'TEE',
        productType: 'CONFIGURABLE',
        optionValues: { color: 'red' },
      });
      const byName = (
        await admin('get', '/variants?search=áo thun&locale=vi-VN').expect(200)
      ).body;
      expect(byName.length).toBe(3);
      expect(byName[0].productName).toBe('Áo thun cổ điển');
      await admin('get', '/variants?limit=99').expect(400);
    });

    it('lists chosen products by id (picker labels)', async () => {
      const list = (
        await admin('get', `/products?ids=${ids.tee},${ids.tee}`).expect(200)
      ).body;
      expect(list.total).toBe(1);
      expect(list.data[0].sku).toBe('TEE');
      await admin('get', '/products?ids=nope').expect(400);
    });

    it('validates attribute values, SKUs and variant combinations', async () => {
      const bad = await admin('post', '/products', {
        sku: 'BAD',
        type: 'SIMPLE',
        attributeSetId: ids.apparel,
        attributes: { color: 'pink', weight: 3 },
        translations: [{ localeCode: 'en-US', name: 'Bad' }],
      }).expect(400);
      expect(bad.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('attributes.color must be one of'),
          expect.stringContaining('attributes.weight is not in'),
        ]),
      );
      await admin('post', '/products', {
        sku: 'TEE-RED-M',
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name: 'Clash', slug: 'clash' }],
      }).expect(409);
      await admin('post', `/products/${ids.tee}/variants`, {
        sku: 'TEE-RED-M2',
        options: { color: 'red', size: 'm' },
      }).expect(409);
      await admin(
        'delete',
        `/products/${ids.tee}/variants/${variantIds['TEE-RED-M']}`,
      ).expect(409); // sold in the outfit bundle
    });

    it('soft-deleted products leave the storefront and their URLs, and come back on restore', async () => {
      await admin('delete', `/products/${ids.giftCard}`).expect(204);
      await store('us-en', `/products/${ids.giftCard}`).expect(404);
      await eventually(
        () => store('us-en', '/url-resolver?path=/gift-card'),
        (r) => r.status === 404,
      );
      await admin('post', `/products/${ids.giftCard}/restore`).expect(200);
      await eventually(
        () => store('us-en', '/url-resolver?path=/gift-card'),
        (r) => r.status === 200,
      );
    });
  });

  describe('media', () => {
    it('uploads to object storage, links images, and the worker renders WebP renditions', async () => {
      const png = await sharp({
        create: {
          width: 1600,
          height: 1200,
          channels: 3,
          background: '#d32f2f',
        },
      })
        .png()
        .toBuffer();
      const up = await admin('post', '/images')
        .attach('file', png, 'red-tee.png')
        .field('localeCode', 'en-US')
        .field('alt', 'Red tee')
        .expect(201);
      expect(up.body).toMatchObject({
        mime: 'image/png',
        width: 1600,
        height: 1200,
        alts: [{ localeCode: 'en-US', alt: 'Red tee' }],
      });
      const again = await admin('post', '/images')
        .attach('file', png, 'copy.png')
        .expect(201);
      expect(again.body.id).toBe(up.body.id); // deduplicated by content
      await admin('post', '/images')
        .attach('file', Buffer.from('not an image'), 'x.png')
        .expect(400);

      await admin('put', `/products/${ids.tee}/images`, {
        images: [{ imageId: up.body.id, role: 'BASE' }],
      }).expect(200);
      await admin(
        'put',
        `/products/${ids.tee}/variants/${variantIds['TEE-RED-S']}/images`,
        { images: [{ imageId: up.body.id, role: 'SWATCH' }] },
      ).expect(200);
      await admin(
        'put',
        `/products/00000000-0000-4000-8000-000000000000/images`,
        { images: [{ imageId: up.body.id, role: 'BASE' }] },
      ).expect(404);

      const page = await eventually(
        () => store('us-en', `/products/${ids.tee}`).then((r) => r.body),
        (b) => b.images?.[0]?.renditions?.length === 3,
        20_000,
      );
      expect(page.images[0]).toMatchObject({
        role: 'BASE',
        alt: 'Red tee',
        width: 1600,
      });
      expect(page.images[0].renditions.map((r: Body) => r.width)).toEqual([
        200, 600, 1200,
      ]);
      const fetched = await fetch(page.images[0].renditions[0].url);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe('image/webp');
      expect(
        page.variants.find((v: Body) => v.sku === 'TEE-RED-S').images,
      ).toHaveLength(1);

      const card = (
        await store('us-en', `/categories/${ids.tees}/products`).expect(200)
      ).body.data[0];
      expect(card.image).toMatchObject({ role: 'BASE' });
      await admin('delete', `/images/${up.body.id}`).expect(409);
    });
  });
});
