/**
 * Phase 2 "done": correct net/gross price per store, group, currency and qty for EU/US/VN fixtures;
 * no overselling under concurrency. Real API + worker against PostgreSQL, Redis (password), MinIO.
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Pricing, tax and inventory (e2e)', () => {
  let stack: TestStack;
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
  const product = (store: string, productId: string, currency?: string) => {
    const r = http()
      .get(`/api/v1/store/products/${productId}`)
      .set('x-store', store);
    return (currency ? r.set('x-currency', currency) : r).then(
      (res) => res.body as Body,
    );
  };
  /** Waits until the async price index serves the expected amount. */
  const priced = (
    store: string,
    productId: string,
    amount: number,
    currency?: string,
  ) =>
    eventually(
      () => product(store, productId, currency),
      (b) => b.price?.amount === amount,
      20_000,
    );

  beforeAll(async () => {
    stack = await startStack();
    app = await startApp();
    worker = await startWorker(['price-index', 'inventory']);
    token = await rootToken(app);

    for (const c of ['EUR', 'VND'])
      await admin('patch', `/currencies/${c}`, { isActive: true }).expect(200);
    await admin('patch', '/locales/vi-VN', { isActive: true }).expect(200);
    for (const [code, currency] of [
      ['us', 'USD'],
      ['eu', 'EUR'],
      ['vn', 'VND'],
    ])
      id[code] = (
        await admin('post', '/websites', {
          code,
          name: code.toUpperCase(),
          baseCurrencyCode: currency,
        }).expect(201)
      ).body.id;
    const store = async (code: string, websiteId: string, o: object) =>
      (
        await admin('post', '/stores', {
          code,
          name: code,
          websiteId,
          ...o,
        }).expect(201)
      ).body.id as string;
    id.usStore = await store('us-en', id.us, {
      defaultLocaleCode: 'en-US',
      defaultCurrencyCode: 'USD',
      countryCode: 'US',
    });
    id.deStore = await store('de-de', id.eu, {
      defaultLocaleCode: 'en-US',
      defaultCurrencyCode: 'EUR',
      countryCode: 'DE',
      pricesIncludeTax: true,
    });
    id.vnStore = await store('vn-vi', id.vn, {
      defaultLocaleCode: 'vi-VN',
      defaultCurrencyCode: 'VND',
      currencyCodes: ['USD'],
      countryCode: 'VN',
      pricesIncludeTax: true,
    });

    // ── Tax: classes, zones, rates.
    const classes = (await admin('get', '/tax/classes').expect(200))
      .body as Body[];
    const cls = (code: string) =>
      classes.find((c) => c.code === code)!.id as string;
    const zone = async (code: string, regions: object[]) =>
      (
        await admin('post', '/tax/zones', { code, name: code, regions }).expect(
          201,
        )
      ).body.id as string;
    const de = await zone('de', [{ countryCode: 'DE' }]);
    const vn = await zone('vn', [{ countryCode: 'VN' }]);
    const ca = await zone('us-ca', [{ countryCode: 'US', regionCode: 'CA' }]);
    const la = await zone('us-ca-la', [
      { countryCode: 'US', regionCode: 'CA', postcodePattern: '900*' },
    ]);
    const rate = (zoneId: string, cl: string, r: string, name = 'VAT') =>
      admin('post', '/tax/rates', {
        zoneId,
        productTaxClassId: cls(cl),
        name,
        rate: r,
      }).expect(201);
    await rate(de, 'standard', '19');
    await rate(de, 'reduced', '7');
    await rate(vn, 'standard', '10');
    await rate(ca, 'standard', '7.25', 'CA state');
    await rate(la, 'standard', '2.25', 'LA county');

    // ── Products sold everywhere.
    const websiteIds = [id.us, id.eu, id.vn];
    const tee = (
      await admin('post', '/products', {
        sku: 'TEE',
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name: 'Tee' }],
        websiteIds,
        weightGrams: 200,
      }).expect(201)
    ).body;
    id.tee = tee.id;
    id.teeVariant = tee.variants[0].id;
    id.book = (
      await admin('post', '/products', {
        sku: 'BOOK',
        type: 'SIMPLE',
        taxClassId: cls('reduced'),
        translations: [{ localeCode: 'en-US', name: 'Book' }],
        websiteIds,
      }).expect(201)
    ).body.id;
    await admin('patch', `/products/${id.book}`, {
      taxClassId: cls('retail'),
    }).expect(400); // a customer class is refused

    // ── Price books.
    const groups = (await admin('get', '/customer-groups').expect(200))
      .body as Body[];
    id.wholesale = groups.find((g) => g.code === 'wholesale')!.id;
    const book = async (o: object) =>
      (await admin('post', '/price-books', o).expect(201)).body.id as string;
    const prices = (bookId: string, entries: object[]) =>
      admin('put', `/price-books/${bookId}/entries`, { entries }).expect(200);
    id.usList = await book({
      code: 'us-list',
      name: 'US list',
      currencyCode: 'USD',
      websiteId: id.us,
    });
    await prices(id.usList, [
      { sku: 'TEE', amount: 2500 },
      { sku: 'TEE', minQty: 10, amount: 1800 },
      { sku: 'BOOK', amount: 1500 },
    ]);
    id.usSale = await book({
      code: 'us-sale',
      name: 'US sale',
      currencyCode: 'USD',
      websiteId: id.us,
      priority: 10,
      validTo: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await prices(id.usSale, [
      { sku: 'TEE', amount: 1999, compareAtAmount: 2500 },
    ]);
    id.euList = await book({
      code: 'eu-list',
      name: 'EU list',
      currencyCode: 'EUR',
      websiteId: id.eu,
      includesTax: true,
    });
    await prices(id.euList, [
      { sku: 'TEE', amount: 2999 },
      { sku: 'BOOK', amount: 1070 },
    ]);
    id.euWholesale = await book({
      code: 'eu-wholesale',
      name: 'EU wholesale',
      currencyCode: 'EUR',
      websiteId: id.eu,
      customerGroupId: id.wholesale,
    });
    await prices(id.euWholesale, [{ sku: 'TEE', amount: 2000 }]);
    id.vnList = await book({
      code: 'vn-list',
      name: 'VN list',
      currencyCode: 'VND',
      websiteId: id.vn,
      includesTax: true,
    });
    await prices(id.vnList, [{ sku: 'TEE', amount: 599000 }]);
    await admin('post', '/exchange-rates', {
      baseCurrencyCode: 'USD',
      quoteCurrencyCode: 'VND',
      rate: '25000',
    }).expect(201);

    // ── Inventory: one warehouse per region; the EU website falls back to the US warehouse.
    id.usWh = (
      await admin('post', '/inventory/sources', {
        code: 'us-wh',
        name: 'US warehouse',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
    id.euWh = (
      await admin('post', '/inventory/sources', {
        code: 'eu-wh',
        name: 'EU warehouse',
        countryCode: 'DE',
      }).expect(201)
    ).body.id;
    await admin('put', `/websites/${id.us}/inventory-sources`, {
      sources: [{ sourceId: id.usWh }],
    }).expect(200);
    await admin('put', `/websites/${id.eu}/inventory-sources`, {
      sources: [{ sourceId: id.euWh }, { sourceId: id.usWh }],
    }).expect(200);
    await admin('post', '/inventory/adjustments', {
      sourceId: id.usWh,
      sku: 'TEE',
      delta: 10,
    }).expect(200);
    await admin('post', '/inventory/adjustments', {
      sourceId: id.euWh,
      sku: 'TEE',
      delta: 3,
    }).expect(200);
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await stack?.stop();
  });

  describe('prices per store, currency, group and quantity', () => {
    it('US (net prices): the sale book beats the list price; quantity tiers only lower it', async () => {
      const p = await priced('us-en', id.tee, 1999);
      expect(p.price).toMatchObject({
        currency: 'USD',
        amount: 1999,
        net: 1999,
        gross: 1999,
        includesTax: false,
        compareAt: 2500,
        formatted: '$19.99',
        tiers: [{ minQty: 10, amount: 1800 }],
      });
    });

    it('Germany (inclusive): gross stays as entered, net is back-calculated; reduced rate for books', async () => {
      const tee = await priced('de-de', id.tee, 2999);
      expect(tee.price).toMatchObject({
        currency: 'EUR',
        amount: 2999,
        gross: 2999,
        net: 2520,
        includesTax: true,
        taxRate: '19.0000',
      });
      const book = await priced('de-de', id.book, 1070);
      expect(book.price).toMatchObject({
        net: 1000,
        gross: 1070,
        taxRate: '7.0000',
      });
    });

    it('Vietnam (VND, 0 decimals) and display in USD via the exchange rate', async () => {
      const vnd = await priced('vn-vi', id.tee, 599000);
      expect(vnd.price).toMatchObject({
        currency: 'VND',
        gross: 599000,
        net: 544545,
        converted: false,
        taxRate: '10.0000',
      });
      const usd = await priced('vn-vi', id.tee, 2396, 'USD');
      expect(usd.price).toMatchObject({
        currency: 'USD',
        converted: true,
        amount: 2396,
      });
    });

    it('wholesale customers get their own (net) book; the preview shows line tax for a quantity', async () => {
      const r = await admin(
        'get',
        `/prices/preview?variantId=${id.teeVariant}&storeId=${id.deStore}&customerGroup=wholesale&qty=3`,
      ).expect(200);
      expect(r.body).toMatchObject({
        books: ['eu-wholesale', 'eu-list'],
        applied: {
          minQty: 1,
          net: 2000,
          gross: 2380,
          priceBook: 'eu-wholesale',
        },
        lineNet: 6000,
        lineTax: 1140,
        lineGross: 7140,
        taxRate: '19.0000',
        currency: 'EUR',
      });
      const guest = await admin(
        'get',
        `/prices/preview?variantId=${id.teeVariant}&storeId=${id.deStore}`,
      ).expect(200);
      expect(guest.body.applied).toMatchObject({
        gross: 2999,
        priceBook: 'eu-list',
      });
    });

    it('ending the sale reindexes back to the list price', async () => {
      await admin('patch', `/price-books/${id.usSale}`, {
        isActive: false,
      }).expect(200);
      const p = await priced('us-en', id.tee, 2500);
      expect(p.price.compareAt).toBeNull();
    });

    it('calculates multi-jurisdiction tax for checkout', async () => {
      const r = await admin('post', '/tax/calculate', {
        destination: { countryCode: 'US', regionCode: 'CA', postcode: '90012' },
        pricesIncludeTax: false,
        lines: [{ key: 'tee', amount: 10000 }],
      }).expect(200);
      expect(r.body).toMatchObject({
        totals: { net: 10000, tax: 950, gross: 10950 },
        zones: ['us-ca', 'us-ca-la'],
      });
    });
  });

  describe('inventory', () => {
    it('salable quantity per website sums its sources', async () => {
      const us = await eventually(
        () => product('us-en', id.tee),
        (b) => b.variants?.[0]?.stock?.salable === 10,
      );
      expect(us.variants[0].stock).toEqual({
        managed: true,
        inStock: true,
        salable: 10,
      });
      const de = await product('de-de', id.tee);
      expect(de.variants[0].stock.salable).toBe(13);
      expect(de.inStock).toBe(true);
    });

    it('reservations allocate by source priority and can be released', async () => {
      const r = await admin('post', '/inventory/reservations', {
        sku: 'TEE',
        websiteId: id.eu,
        quantity: 5,
        referenceType: 'CART',
        referenceId: 'cart-eu',
      }).expect(201);
      expect(r.body.lines).toEqual([
        { sourceId: id.euWh, quantity: 3 },
        { sourceId: id.usWh, quantity: 2 },
      ]);
      expect((await product('us-en', id.tee)).variants[0].stock.salable).toBe(
        8,
      );
      await admin(
        'post',
        `/inventory/reservations/${r.body.groupId}/release`,
      ).expect(200);
      await admin(
        'post',
        `/inventory/reservations/${r.body.groupId}/release`,
      ).expect(200); // idempotent
      await admin(
        'post',
        `/inventory/reservations/${r.body.groupId}/convert`,
      ).expect(409);
      expect((await product('us-en', id.tee)).variants[0].stock.salable).toBe(
        10,
      );
    });

    it('never oversells: 40 concurrent checkouts for 10 units → exactly 10 succeed', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          admin('post', '/inventory/reservations', {
            variantId: id.teeVariant,
            websiteId: id.us,
            quantity: 1,
            referenceType: 'CART',
            referenceId: `race-${i}`,
          }),
        ),
      );
      const ok = attempts.filter((r) => r.status === 201);
      expect(ok).toHaveLength(10);
      expect(attempts.filter((r) => r.status === 409)).toHaveLength(30);
      const stock = (
        await admin(
          'get',
          `/inventory/stock?sourceId=${id.usWh}&sku=TEE`,
        ).expect(200)
      ).body.data[0];
      expect(stock).toMatchObject({ quantity: 10, reserved: 10, salable: 0 });
      const page = await product('us-en', id.tee);
      expect(page.inStock).toBe(false);

      // Sell one, release one, let the rest expire.
      await admin(
        'post',
        `/inventory/reservations/${ok[0].body.groupId}/convert`,
      ).expect(200);
      await admin(
        'post',
        `/inventory/reservations/${ok[1].body.groupId}/release`,
      ).expect(200);
      const { ReservationsService } =
        await import('../src/modules/inventory/reservations.service.js');
      expect(
        await app
          .get(ReservationsService)
          .expire(new Date(Date.now() + 3_600_000)),
      ).toBe(8);
      const after = (
        await admin(
          'get',
          `/inventory/stock?sourceId=${id.usWh}&sku=TEE`,
        ).expect(200)
      ).body.data[0];
      expect(after).toMatchObject({ quantity: 9, reserved: 0, salable: 9 });
      const ledger = (
        await admin(
          'get',
          `/inventory/movements?variantId=${id.teeVariant}&sourceId=${id.usWh}`,
        ).expect(200)
      ).body.data as Body[];
      expect(ledger.map((m) => [m.reason, m.delta, m.quantityAfter])).toEqual([
        ['SALE', -1, 9],
        ['RECEIPT', 10, 10],
      ]);
    });

    it('guards adjustments: not below reserved, optimistic versions, no stock for virtual goods', async () => {
      const r = await admin('post', '/inventory/reservations', {
        sku: 'TEE',
        websiteId: id.us,
        quantity: 4,
        referenceType: 'ORDER',
        referenceId: 'o-1',
      }).expect(201);
      await admin('post', '/inventory/adjustments', {
        sourceId: id.usWh,
        sku: 'TEE',
        quantity: 3,
      }).expect(409);
      const row = (
        await admin(
          'get',
          `/inventory/stock?sourceId=${id.usWh}&sku=TEE`,
        ).expect(200)
      ).body.data[0];
      await admin('post', '/inventory/adjustments', {
        sourceId: id.usWh,
        sku: 'TEE',
        delta: 1,
        expectedVersion: row.version - 1,
      }).expect(409);
      await admin('post', '/inventory/adjustments', {
        sourceId: id.usWh,
        sku: 'TEE',
        delta: 1,
        expectedVersion: row.version,
      }).expect(200);
      await admin(
        'post',
        `/inventory/reservations/${r.body.groupId}/release`,
      ).expect(200);
      const gc = (
        await admin('post', '/products', {
          sku: 'GC',
          type: 'GIFT_CARD',
          typeOptions: { amounts: [{ currency: 'USD', amount: 2500 }] },
          translations: [{ localeCode: 'en-US', name: 'GC' }],
          websiteIds: [id.us],
        }).expect(201)
      ).body;
      await admin('post', '/inventory/adjustments', {
        sourceId: id.usWh,
        sku: 'GC',
        delta: 5,
      }).expect(400);
      const res = await admin('post', '/inventory/reservations', {
        sku: 'GC',
        websiteId: id.us,
        quantity: 1000,
        referenceType: 'CART',
        referenceId: 'x',
      }).expect(201);
      expect(res.body.managed).toBe(false);
      expect((await product('us-en', gc.id)).inStock).toBe(true);
    });

    it('filters prices, stock and movements by product and SKU search (admin screens)', async () => {
      const entries = (
        await admin(
          'get',
          `/price-books/${id.usList}/entries?productId=${id.tee}`,
        ).expect(200)
      ).body;
      expect(entries.data.map((e: { sku: string }) => e.sku)).toEqual([
        'TEE',
        'TEE',
      ]);
      expect(
        (
          await admin(
            'get',
            `/price-books/${id.usList}/entries?search=bo`,
          ).expect(200)
        ).body.data.map((e: { sku: string }) => e.sku),
      ).toEqual(['BOOK']);
      const stock = (
        await admin('get', `/inventory/stock?productId=${id.tee}`).expect(200)
      ).body;
      expect(stock.data.length).toBeGreaterThan(0);
      expect(stock.data.every((s: { sku: string }) => s.sku === 'TEE')).toBe(
        true,
      );
      expect(
        (await admin('get', '/inventory/stock?search=te').expect(200)).body
          .total,
      ).toBe(stock.total);
      const moves = (
        await admin('get', `/inventory/movements?productId=${id.tee}`).expect(
          200,
        )
      ).body;
      expect(moves.data.length).toBeGreaterThan(0);
      expect(moves.data[0]).toMatchObject({ sku: 'TEE' });
    });

    it('reconciliation repairs reserved-counter drift', async () => {
      const { PrismaService } =
        await import('../src/database/prisma.service.js');
      const prisma = app.get(PrismaService);
      await prisma.$executeRaw`UPDATE inventories SET reserved = 2 WHERE source_id = ${id.usWh}::uuid`;
      const { ReservationsService } =
        await import('../src/modules/inventory/reservations.service.js');
      expect(await app.get(ReservationsService).reconcile()).toEqual({
        checked: 1,
        fixed: 1,
      });
      expect(
        (
          await admin(
            'get',
            `/inventory/stock?sourceId=${id.usWh}&sku=TEE`,
          ).expect(200)
        ).body.data[0].reserved,
      ).toBe(0);
    });
  });
});
