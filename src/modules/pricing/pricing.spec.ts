import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../database/generated/prisma/client.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { Fraction } from '../tax/fraction.js';
import { convertMinor, decimal, formatMoney } from './money.js';
import { PriceBooksService } from './price-books.service.js';
import { PriceComputation } from './price-computation.js';
import { PriceIndexListener } from './price-index.listener.js';
import {
  PriceIndexProcessor,
  PriceIndexScheduler,
} from './price-index.processor.js';
import { PriceIndexer } from './price-indexer.js';
import { PricingController } from './pricing.controller.js';
import { PricingQuery } from './pricing.query.js';

const TAX = {
  zones: [
    {
      id: 'de',
      code: 'de',
      rounding: 'LINE' as const,
      regions: [{ countryCode: 'DE', regionCode: null, postcodePattern: null }],
    },
  ],
  rates: [
    {
      id: 'r',
      zoneId: 'de',
      productTaxClassId: 'std',
      customerTaxClassId: null,
      name: 'VAT',
      rate: '19',
      priority: 0,
      isCompound: false,
      validFrom: new Date('1970-01-01'),
      validTo: null,
    },
  ],
  classIds: new Map([
    ['standard', 'std'],
    ['retail', 'ret'],
  ]),
};
const book = (code: string, o: object = {}) => ({
  id: code,
  code,
  currencyCode: 'EUR',
  websiteId: null,
  storeId: null,
  customerGroupId: null,
  includesTax: false,
  priority: 100,
  validFrom: null,
  validTo: null,
  isActive: true,
  ...o,
});
const entry = (
  priceBookId: string,
  amount: number,
  minQty = 1,
  compareAt: number | null = null,
) => ({
  variantId: 'v',
  priceBookId,
  minQty,
  amount: BigInt(amount),
  compareAtAmount: compareAt === null ? null : BigInt(compareAt),
});

describe('money', () => {
  it('formats per locale and converts between minor units', () => {
    expect(formatMoney(2599, 'USD', 2, 'en-US')).toBe('$25.99');
    expect(formatMoney(250000, 'VND', 0, 'vi-VN')).toMatch(/250\.000/);
    expect(formatMoney(5, 'XXX', 2, 'zz-invalid-locale-%')).toBe('0.05 XXX');
    expect(convertMinor(599000n, new Fraction(1n, 25000n), 0, 2)).toBe(2396n);
    expect(convertMinor(1999n, '25000', 2, 0)).toBe(499750n);
    expect(decimal('1.5').mul(Fraction.of(2)).round()).toBe(3n);
  });
});

describe('PriceComputation', () => {
  const setting = {
    destination: { countryCode: 'DE' },
    productTaxClassId: 'std',
    customerTaxClassId: 'ret',
  };
  const ctx = {
    storeId: 's',
    websiteId: 'w',
    customerGroupId: 'g',
    currencyCode: 'EUR',
  };

  it('net and gross for inclusive and net books, compare-at too, cached splits', () => {
    const c = new PriceComputation(
      TAX,
      [book('gross', { includesTax: true }), book('net', { priority: 200 })],
      new Date(),
    );
    const tiers = c.tiers(
      ctx,
      [entry('gross', 2999, 1, 3999), entry('net', 2000, 5)],
      setting,
    );
    expect(
      tiers.map((t) => [
        t.minQty,
        Number(t.net),
        Number(t.gross),
        t.compareAtGross === null ? null : Number(t.compareAtGross),
        t.book.code,
      ]),
    ).toEqual([
      [1, 2520, 2999, 3999, 'gross'],
      [5, 2000, 2380, null, 'net'],
    ]);
    expect(c.taxRate(setting)).toBe('19.0000');
    expect(c.split(100n, false, setting)).toBe(c.split(100n, false, setting));
    expect(c.ranked(ctx).map((b) => b.code)).toEqual(['gross', 'net']);
  });
});

describe('PriceBooksService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const products = {
      variantIdsBySku: vi.fn(
        async (skus: string[]) =>
          new Map(skus.filter((s) => s !== 'NOPE').map((s) => [s, `v-${s}`])),
      ),
    };
    return {
      svc: new PriceBooksService(prisma as never, fb.bus, products as never),
      prisma,
      ...fb,
    };
  }
  const row = (o: object = {}) => ({
    ...book('us'),
    name: 'US',
    _count: { entries: 2 },
    ...o,
  });

  it('books: scope rules, events with ids for the indexer', async () => {
    const { svc, prisma, after } = setup();
    await expect(
      svc.create(
        {
          code: 'x',
          name: 'X',
          currencyCode: 'USD',
          websiteId: 'w',
          storeId: 's',
        },
        ROOT,
      ),
    ).rejects.toThrow('website or a store');
    await expect(
      svc.create(
        {
          code: 'x',
          name: 'X',
          currencyCode: 'USD',
          validFrom: '2026-02-01',
          validTo: '2026-01-01',
        },
        ROOT,
      ),
    ).rejects.toThrow('validTo');
    prisma.priceBook.create.mockResolvedValue(row());
    expect(
      (
        await svc.create(
          { code: 'us', name: 'US', currencyCode: 'USD', validFrom: null },
          ROOT,
        )
      ).entryCount,
    ).toBe(2);
    prisma.priceBook.findUnique.mockResolvedValue(row());
    await expect(
      svc.update('us', { storeId: 's', websiteId: 'w' }, ROOT),
    ).rejects.toThrow('website or a store');
    prisma.priceBook.update.mockResolvedValue(row({ priority: 5 }));
    await svc.update('us', { priority: 5 }, ROOT);
    await svc.remove('us', ROOT);
    expect(
      after.map((e) => [e.name, (e as unknown as { data: object }).data]),
    ).toEqual([
      ['price-book.created', { priceBookId: 'us' }],
      ['price-book.updated', { priceBookId: 'us' }],
      ['price-book.deleted', { priceBookId: 'us' }],
    ]);
    prisma.priceBook.findUnique.mockResolvedValue(null);
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.priceBook.findMany.mockResolvedValue([row()]);
    expect(await svc.list()).toHaveLength(1);
  });

  it('entries: SKU lookup, validation, upsert, variants reported', async () => {
    const { svc, prisma, after } = setup();
    const err = await svc
      .setEntries(
        'b',
        {
          entries: [
            { sku: 'NOPE', amount: 1 },
            { amount: 1 },
            { sku: 'A', amount: 5, compareAtAmount: 5 },
            { sku: 'B', amount: 1 },
            { sku: 'B', amount: 2 },
          ],
        },
        ROOT,
      )
      .catch(
        (e: BadRequestException) =>
          (e.getResponse() as { message: string[] }).message,
      );
    expect(err).toEqual([
      'entries[0]: unknown SKU NOPE',
      'entries[1]: variantId or sku is required',
      'entries[2]: compareAtAmount must be higher than amount',
      'An entry (variant, minQty) appears twice',
    ]);
    await expect(
      svc.setEntries('b', { entries: [{ sku: 'A', amount: 1 }] }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.priceBook.count.mockResolvedValue(1);
    expect(
      await svc.setEntries(
        'b',
        {
          entries: [
            { sku: 'A', amount: 100 },
            { variantId: 'v2', minQty: 10, amount: 90, compareAtAmount: null },
          ],
        },
        ROOT,
      ),
    ).toEqual({ upserted: 2 });
    expect(prisma.priceBookEntry.upsert).toHaveBeenCalledTimes(2);
    expect(after[0]).toMatchObject({
      name: 'price-book.entries-changed',
      data: { variantIds: ['v-A', 'v2'] },
    });
    prisma.priceBookEntry.findFirst.mockResolvedValue({
      variantId: 'v2',
      minQty: 10,
    });
    await svc.removeEntry('b', 'e', ROOT);
    prisma.priceBookEntry.findFirst.mockResolvedValue(null);
    await expect(svc.removeEntry('b', 'e', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.priceBookEntry.findMany.mockResolvedValue([
      {
        id: 'e',
        variantId: 'v',
        minQty: 1,
        amount: 5n,
        compareAtAmount: 9n,
        variant: { sku: 'S' },
      },
    ]);
    prisma.priceBookEntry.count.mockResolvedValue(1);
    expect(
      (
        await svc.entries('b', {
          page: 1,
          limit: 10,
          skip: 0,
          order: 'desc',
        } as never)
      ).data,
    ).toEqual([
      {
        id: 'e',
        variantId: 'v',
        minQty: 1,
        amount: 5,
        compareAtAmount: 9,
        sku: 'S',
      },
    ]);
  });

  it('exchange rates are appended; latest per pair listed', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.addExchangeRate(
        { baseCurrencyCode: 'USD', quoteCurrencyCode: 'USD', rate: '1' },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.exchangeRate.create.mockResolvedValue({
      id: 'x',
      baseCurrencyCode: 'USD',
      quoteCurrencyCode: 'VND',
      rate: new Prisma.Decimal('25000'),
      validFrom: new Date(),
    });
    expect(
      (
        await svc.addExchangeRate(
          { baseCurrencyCode: 'USD', quoteCurrencyCode: 'VND', rate: '25000' },
          ROOT,
        )
      ).rate,
    ).toBe('25000.00000000');
    prisma.exchangeRate.findMany.mockResolvedValue([
      {
        baseCurrencyCode: 'USD',
        quoteCurrencyCode: 'VND',
        rate: new Prisma.Decimal('25000'),
        validFrom: new Date(),
      },
    ]);
    expect((await svc.exchangeRates())[0].rate).toBe('25000.00000000');
  });
});

describe('PriceIndexer', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const store = {
      id: 's',
      websiteId: 'w',
      countryCode: 'DE',
      currencyCodes: ['EUR', 'USD'],
      defaultCurrencyCode: 'EUR',
    };
    const stores = {
      snapshot: vi.fn(async () => ({ byId: new Map([['s', store]]) })),
      store: vi.fn(async (id: string) => (id === 's' ? store : undefined)),
    };
    const customers = {
      groups: vi.fn(async () => [{ id: 'g', code: 'guest', taxClassId: null }]),
      groupByCode: vi.fn(async () => ({
        id: 'g',
        code: 'guest',
        taxClassId: null,
      })),
    };
    const products = {
      variantTaxInfo: vi.fn(
        async (ids: string[]) =>
          new Map(
            ids
              .filter((i) => i !== 'gone')
              .map((i) => [
                i,
                { taxClassId: null, productId: 'p', type: 'SIMPLE' },
              ]),
          ),
      ),
    };
    const tax = { definitions: vi.fn(async () => TAX) };
    prisma.priceBook.findMany.mockResolvedValue([
      book('eu', { includesTax: true }),
    ]);
    prisma.priceBookEntry.findMany.mockResolvedValue([entry('eu', 2999)]);
    const indexer = new PriceIndexer(
      prisma as never,
      fb.bus,
      stores as never,
      customers as never,
      products as never,
      tax as never,
    );
    return { indexer, prisma, tax, stores, ...fb };
  }

  it('rebuilds variants for every store × group × currency with fresh configuration', async () => {
    const { indexer, prisma, tax, stores, after } = setup();
    expect(await indexer.rebuild(['v', 'gone'])).toEqual({
      variants: 2,
      rows: 1,
    });
    expect(tax.definitions).toHaveBeenCalledWith(true);
    expect(stores.snapshot).toHaveBeenCalledWith(true);
    expect(prisma.priceIndex.deleteMany).toHaveBeenCalledWith({
      where: { variantId: { in: ['v', 'gone'] } },
    });
    expect(prisma.priceIndex.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        variantId: 'v',
        storeId: 's',
        currencyCode: 'EUR',
        minQty: 1,
        netAmount: 2520n,
        grossAmount: 2999n,
        taxRate: '19.0000',
        priceBookId: 'eu',
      }),
    ]);
    expect(after[0]).toMatchObject({ name: 'price-index.rebuilt' });
  });

  it('full rebuild covers priced and previously indexed variants', async () => {
    const { indexer, prisma } = setup();
    prisma.priceBookEntry.findMany
      .mockResolvedValueOnce([{ variantId: 'v' }])
      .mockResolvedValue([]);
    prisma.priceIndex.findMany.mockResolvedValue([{ variantId: 'stale' }]);
    expect(await indexer.rebuild()).toEqual({ variants: 2, rows: 0 });
    prisma.priceBookEntry.findMany.mockResolvedValue([{ variantId: 'x' }]);
    expect(
      await indexer.variantsWithBoundaries(new Date(0), new Date()),
    ).toEqual(['x']);
  });

  it('preview resolves live and computes the line for a quantity', async () => {
    const { indexer } = setup();
    expect(
      await indexer.preview({ variantId: 'v', storeId: 's', qty: 2 }),
    ).toEqual({
      books: ['eu'],
      tiers: [{ minQty: 1, net: 2520, gross: 2999, priceBook: 'eu' }],
      applied: { minQty: 1, net: 2520, gross: 2999, priceBook: 'eu' },
      qty: 2,
      lineNet: 5040,
      lineTax: 958,
      lineGross: 5998,
      taxRate: '19.0000',
      currency: 'EUR',
    });
    expect(
      (await indexer.preview({ variantId: 'v', storeId: 's', currency: 'USD' }))
        .applied,
    ).toBeNull();
    await expect(
      indexer.preview({ variantId: 'v', storeId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      indexer.preview({ variantId: 'gone', storeId: 's' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PricingQuery', () => {
  const ctx = {
    storeId: 's',
    storeCode: 'vn',
    websiteId: 'w',
    websiteCode: 'vn',
    localeCode: 'en-US',
    localeChain: ['en-US'],
    currencyCode: 'USD',
    countryCode: 'VN',
    pricesIncludeTax: true,
  };
  function setup(pricesIncludeTax = true) {
    const prisma = fakePrisma();
    const snap = {
      byId: new Map([['s', { defaultCurrencyCode: 'VND', pricesIncludeTax }]]),
      currencies: new Map([
        ['VND', { minorUnits: 0 }],
        ['USD', { minorUnits: 2 }],
      ]),
    };
    const q = new PricingQuery(
      prisma as never,
      { snapshot: async () => snap } as never,
      { groupByCode: async () => ({ id: 'g' }) } as never,
    );
    return { q, prisma };
  }
  const idx = (
    variantId: string,
    currencyCode: string,
    minQty: number,
    net: number,
    gross: number,
    cmp?: [number, number],
  ) => ({
    variantId,
    currencyCode,
    minQty,
    netAmount: BigInt(net),
    grossAmount: BigInt(gross),
    compareAtNet: cmp ? BigInt(cmp[0]) : null,
    compareAtGross: cmp ? BigInt(cmp[1]) : null,
    taxRate: new Prisma.Decimal('10'),
  });

  it('serves index rows in the request currency, shown gross or net per store', async () => {
    const { q, prisma } = setup();
    prisma.priceIndex.findMany.mockResolvedValueOnce([
      idx('a', 'USD', 1, 1000, 1100, [1500, 1650]),
      idx('a', 'USD', 10, 900, 990),
    ]);
    const a = (await q.prices(ctx, ['a'])).get('a')!;
    expect(a).toMatchObject({
      currency: 'USD',
      amount: 1100,
      net: 1000,
      gross: 1100,
      includesTax: true,
      taxRate: '10.0000',
      formatted: '$11.00',
      compareAt: 1650,
      tiers: [{ minQty: 10, amount: 990 }],
      converted: false,
    });
    const net = setup(false);
    net.prisma.priceIndex.findMany.mockResolvedValueOnce([
      idx('a', 'USD', 1, 1000, 1100),
    ]);
    expect((await net.q.prices(ctx, ['a'])).get('a')).toMatchObject({
      amount: 1000,
      includesTax: false,
      compareAt: null,
    });
    expect(await q.prices(ctx, [])).toEqual(new Map());
  });

  it('falls back to the store currency converted with the latest (or inverse) exchange rate', async () => {
    const { q, prisma } = setup();
    prisma.priceIndex.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([idx('a', 'VND', 1, 500000, 550000)]);
    prisma.exchangeRate.findMany.mockResolvedValueOnce([
      {
        baseCurrencyCode: 'USD',
        quoteCurrencyCode: 'VND',
        rate: new Prisma.Decimal('25000'),
      },
    ]);
    expect((await q.prices(ctx, ['a'])).get('a')).toMatchObject({
      amount: 2200,
      converted: true,
    });
    prisma.priceIndex.findMany.mockResolvedValueOnce([]);
    prisma.exchangeRate.findMany.mockResolvedValueOnce([]);
    expect((await q.prices(ctx, ['a'])).size).toBe(0);
    prisma.exchangeRate.findMany.mockResolvedValueOnce([
      {
        baseCurrencyCode: 'VND',
        quoteCurrencyCode: 'USD',
        rate: new Prisma.Decimal('0.00004'),
      },
    ]);
    expect((await q.rate('VND', 'USD'))!.toPercent()).toBe('0.0040');
    expect((await q.formatter(ctx))(123, 'USD')).toBe('$1.23');
  });
});

describe('price index jobs', () => {
  it('listener: entries rebuild variants, scope changes queue a coalesced full rebuild', async () => {
    const queue = {
      add: vi.fn(async (_n: string, _d: object, _o: object) => undefined),
    };
    const redis = { incr: vi.fn(async () => 7) };
    const products = { variantIdsOfProduct: vi.fn(async () => ['v1']) };
    const l = new PriceIndexListener(
      queue as never,
      products as never,
      redis as never,
    );
    await l.onEntries({
      data: { priceBookId: 'b', variantIds: ['v'] },
    } as never);
    await l.onEntries({ data: { priceBookId: 'b' } } as never);
    await l.onScopeChanged();
    await l.onProductUpdated({
      data: { productId: 'p', taxClassChanged: true },
    } as never);
    await l.onProductUpdated({ data: { productId: 'p' } } as never);
    expect(queue.add.mock.calls.map((c) => c[1])).toEqual([
      { variantIds: ['v'] },
      { generation: 7 },
      { variantIds: ['v1'] },
    ]);
    expect(queue.add.mock.calls[1][2]).toMatchObject({ delay: 1000 });
  });

  it('processor: skips superseded full rebuilds, refreshes validity boundaries from a cursor', async () => {
    const indexer = {
      rebuild: vi.fn(async () => ({ variants: 1, rows: 1 })),
      variantsWithBoundaries: vi.fn(async () => ['v']),
    };
    const store: Record<string, string> = {
      'price-index:full-generation': '5',
    };
    const redis = {
      get: vi.fn(async (k: string) => store[k] ?? null),
      set: vi.fn(async (k: string, v: string) => (store[k] = v)),
    };
    const p = new PriceIndexProcessor(indexer as never, redis as never);
    expect(
      await p.process({
        id: '1',
        name: 'price-index-rebuild',
        data: { generation: 4 },
      } as never),
    ).toEqual({ skipped: 'superseded by a newer full rebuild' });
    expect(
      await p.process({
        id: '2',
        name: 'price-index-rebuild',
        data: { generation: 5 },
      } as never),
    ).toEqual({ variants: 1, rows: 1 });
    expect(
      await p.process({
        id: '3',
        name: 'price-index-refresh',
        data: {},
      } as never),
    ).toEqual({ variants: 1 });
    expect(redis.set).toHaveBeenCalledWith(
      'price-index:refresh-cursor',
      expect.any(String),
    );
    indexer.variantsWithBoundaries.mockResolvedValue([]);
    expect(await p.refresh()).toEqual({ variants: 0 });
    expect(await p.process({ id: '4', name: 'x', data: {} } as never)).toEqual({
      skipped: 'unknown job x',
    });
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new PriceIndexScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'price-index-refresh',
      expect.anything(),
      expect.anything(),
    );
  });

  it('controller delegates', async () => {
    const books = new Proxy(
      {},
      { get: (_t, k) => vi.fn(async () => k) },
    ) as never;
    const indexer = { preview: vi.fn(async () => 'preview') };
    const queue = { rebuild: vi.fn(async () => undefined) };
    const c = new PricingController(books, indexer as never, queue as never);
    expect(
      await Promise.all([
        c.list(),
        c.get('b'),
        c.create({} as never, ROOT),
        c.update('b', {}, ROOT),
        c.remove('b', ROOT),
        c.entries('b', {} as never),
        c.setEntries('b', {} as never, ROOT),
        c.removeEntry('b', 'e', ROOT),
        c.rates(),
        c.addRate({} as never, ROOT),
        c.preview({} as never),
        c.reindex({ variantIds: ['v'] }),
      ]),
    ).toEqual([
      'list',
      'get',
      'create',
      'update',
      'remove',
      'entries',
      'setEntries',
      'removeEntry',
      'exchangeRates',
      'addExchangeRate',
      'preview',
      { queued: true },
    ]);
    expect(queue.rebuild).toHaveBeenCalledWith(['v']);
  });
});
