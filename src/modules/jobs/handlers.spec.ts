import { BadRequestException } from '@nestjs/common';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { jobContext, outputText } from '../../testing/jobs.js';
import { fakeStores, storeSnap } from '../../testing/stores.js';
import { ExportAuditLogJob } from '../admin/audit/audit.jobs.js';
import { ExportCustomersJob } from '../customers/customers.jobs.js';
import { ExportStockJob, ImportStockJob } from '../inventory/inventory.jobs.js';
import { ExportOrdersJob } from '../orders/orders.jobs.js';
import {
  ExportPricesJob,
  ImportPricesJob,
  PricesReindexJob,
} from '../pricing/pricing.jobs.js';
import { SearchReindexJob } from '../search/search.jobs.js';
import { UrlRewritesRebuildJob } from '../url-rewrites/url-rewrites.jobs.js';
import { JobCanceledError } from './job-handler.js';

const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lines = (o: { output?: { body: Buffer } }) =>
  outputText(o).trim().split('\n');

describe('price jobs', () => {
  const products = {
    skusByVariantId: vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, `SKU-${id}`])),
    ),
    variantIdsBySku: vi.fn(
      async (skus: string[]) =>
        new Map(
          skus.filter((s) => s.startsWith('TEE')).map((s) => [s, `v-${s}`]),
        ),
    ),
  };

  it('exports entries as decimals in each book currency', async () => {
    const prisma = fakePrisma();
    prisma.priceBook.count.mockResolvedValue(1);
    prisma.priceBookEntry.findMany
      .mockResolvedValueOnce([
        {
          id: 'e1',
          variantId: 'v1',
          minQty: 1,
          amount: 2500n,
          compareAtAmount: 3000n,
          priceBook: { code: 'us-retail', currencyCode: 'USD' },
        },
        {
          id: 'e2',
          variantId: 'v1',
          minQty: 1,
          amount: 399000n,
          compareAtAmount: null,
          priceBook: { code: 'vn-retail', currencyCode: 'VND' },
        },
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportPricesJob(
      prisma as never,
      products as never,
      fakeStores() as never,
    );
    expect(await job.validate({ priceBook: 'us-retail' })).toEqual({
      priceBook: 'us-retail',
    });
    expect(await job.validate({})).toEqual({});
    prisma.priceBook.count.mockResolvedValue(0);
    await expect(job.validate({ priceBook: 'nope' })).rejects.toThrow(
      'Unknown price book nope',
    );
    await expect(job.validate({ priceBook: 'Bad Code' })).rejects.toThrow(
      'priceBook is not valid',
    );
    const out = await job.run(
      jobContext('', { params: { priceBook: 'us-retail' } }),
    );
    expect(lines(out)).toEqual([
      'price_book,currency,sku,min_qty,price,compare_at_price',
      'us-retail,USD,SKU-v1,1,25.00,30.00',
      'vn-retail,VND,SKU-v1,1,399000,',
    ]);
    expect(out.output!.name).toMatch(/^prices-us-retail-/);
    expect(prisma.priceBookEntry.findMany.mock.calls[0][0].where).toEqual({
      priceBook: { code: 'us-retail' },
    });
  });

  it('imports valid rows per book and reports the others', async () => {
    const prisma = fakePrisma();
    prisma.priceBook.findMany.mockResolvedValue([
      { id: 'b-us', code: 'us-retail', currencyCode: 'USD' },
      { id: 'b-vn', code: 'vn-retail', currencyCode: 'VND' },
    ]);
    const books = {
      setEntries: vi.fn<AnyFn>(async (_id, dto: { entries: unknown[] }) => ({
        upserted: dto.entries.length,
      })),
    };
    const job = new ImportPricesJob(
      prisma as never,
      books as never,
      products as never,
      fakeStores() as never,
    );
    const csv = [
      'price_book,currency,sku,min_qty,price,compare_at_price',
      ',,TEE-1,,25,30',
      'vn-retail,VND,TEE-1,5,350000,',
      'nope,,TEE-1,,1,',
      'us-retail,EUR,TEE-1,,1,',
      'us-retail,,MUG,,1,',
      'us-retail,,TEE-2,0,1,',
      'us-retail,,TEE-2,,1.234,',
      'us-retail,,TEE-2,,1,x',
      'us-retail,,TEE-2,,10,9',
      'us-retail,,TEE-1,,26,',
    ].join('\n');
    const ctx = jobContext(csv, { params: { priceBook: 'us-retail' } });
    expect((await job.run(ctx)).stats).toEqual({
      rows: 10,
      upserted: 2,
      failed: 8,
    });
    expect(
      books.setEntries.mock.calls.map((c) => [c[0], c[1].entries]),
    ).toEqual([
      [
        'b-us',
        [{ sku: 'TEE-1', minQty: 1, amount: 2500, compareAtAmount: 3000 }],
      ],
      ['b-vn', [{ sku: 'TEE-1', minQty: 5, amount: 350000 }]],
    ]);
    expect(ctx.errors.map((e) => e.message)).toEqual([
      'Unknown price book nope',
      'us-retail is priced in USD, not EUR',
      'Unknown SKU MUG',
      'min_qty must be a whole number from 1',
      'price must be a non-negative amount with at most 2 decimals',
      'compare_at_price is not a valid amount',
      'compare_at_price must be higher than price',
      'TEE-1 (min_qty 1) appears twice for us-retail',
    ]);
    books.setEntries.mockRejectedValueOnce(
      new BadRequestException(['entries[0]: unknown SKU TEE-1']),
    );
    const again = jobContext('sku,price\nTEE-1,1\n', {
      params: { priceBook: 'us-retail' },
    });
    expect((await job.run(again)).stats).toEqual({
      rows: 1,
      upserted: 0,
      failed: 1,
    });
    expect(again.errors[0].message).toBe('entries[0]: unknown SKU TEE-1');
    const noBook = jobContext('sku,price\nTEE-1,1\n');
    await job.run(noBook);
    expect(noBook.errors[0].message).toContain('no priceBook parameter');
  });

  it('a full price index rebuild', async () => {
    const index = { rebuild: vi.fn() };
    const job = new PricesReindexJob(index as never);
    expect(await job.validate({})).toEqual({});
    expect(await job.run()).toEqual({ stats: { queued: 1 } });
    expect(index.rebuild).toHaveBeenCalledWith();
  });
});

describe('stock jobs', () => {
  const products = {
    skusByVariantId: vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, `SKU-${id}`])),
    ),
    variantIdsBySku: vi.fn(
      async (skus: string[]) =>
        new Map(
          skus.filter((s) => s.startsWith('TEE')).map((s) => [s, `v-${s}`]),
        ),
    ),
  };

  it('exports stock with salable quantities', async () => {
    const prisma = fakePrisma();
    prisma.inventorySource.count.mockResolvedValue(1);
    prisma.inventory.findMany
      .mockResolvedValueOnce([
        {
          id: 'i1',
          variantId: 'v1',
          quantity: 10,
          reserved: 3,
          safetyStock: 2,
          source: { code: 'main' },
        },
        {
          id: 'i2',
          variantId: 'v2',
          quantity: 1,
          reserved: 3,
          safetyStock: 0,
          source: { code: 'main' },
        },
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportStockJob(prisma as never, products as never);
    expect(await job.validate({ source: 'main' })).toEqual({ source: 'main' });
    const out = await job.run(jobContext());
    expect(lines(out)).toEqual([
      'source,sku,quantity,reserved,safety_stock,salable',
      'main,SKU-v1,10,3,2,5',
      'main,SKU-v2,1,3,0,0',
    ]);
    prisma.inventorySource.count.mockResolvedValue(0);
    await expect(job.validate({ source: 'other' })).rejects.toThrow(
      'Unknown inventory source other',
    );
  });

  it('sets counted quantities, skipping unchanged rows', async () => {
    const prisma = fakePrisma();
    prisma.inventorySource.findMany.mockResolvedValue([
      { id: 'src-main', code: 'main' },
    ]);
    prisma.inventory.findMany.mockResolvedValue([
      {
        sourceId: 'src-main',
        variantId: 'v-TEE-1',
        quantity: 10,
        safetyStock: 0,
      },
    ]);
    const inventory = { adjust: vi.fn<AnyFn>(async () => ({})) };
    const job = new ImportStockJob(
      prisma as never,
      inventory as never,
      products as never,
    );
    const csv = [
      'source,sku,quantity,safety_stock,reserved,salable',
      'main,TEE-1,10,,3,7',
      'main,TEE-2,25,2,,',
      ',TEE-3,1,,,',
      'other,TEE-3,1,,,',
      'main,MUG,1,,,',
      'main,TEE-3,-1,,,',
      'main,TEE-3,1,x,,',
      'main,TEE-2,1,,,',
    ].join('\n');
    const ctx = jobContext(csv);
    expect((await job.run(ctx)).stats).toEqual({
      rows: 8,
      updated: 1,
      unchanged: 1,
      failed: 6,
    });
    expect(inventory.adjust.mock.calls[0][0]).toEqual({
      sourceId: 'src-main',
      sku: 'TEE-2',
      quantity: 25,
      safetyStock: 2,
      reason: 'CORRECTION',
      note: 'Import e1',
    });
    expect(ctx.errors.map((e) => e.message)).toEqual([
      'source is empty and no source parameter was given',
      'Unknown inventory source other',
      'Unknown SKU MUG',
      'quantity must be a whole number ≥ 0',
      'safety_stock must be a whole number ≥ 0',
      'TEE-2 appears twice for main',
    ]);
    inventory.adjust.mockRejectedValueOnce(
      new BadRequestException("Quantity can't go below the 3 unit(s) reserved"),
    );
    const again = jobContext('sku,quantity\nTEE-5,0\n', {
      params: { source: 'main' },
    });
    expect((await job.run(again)).stats.failed).toBe(1);
    expect(again.errors[0].message).toContain('reserved');
  });
});

describe('customer, order and audit exports', () => {
  it('customers, filtered by website and consent', async () => {
    const prisma = fakePrisma();
    prisma.customer.findMany
      .mockResolvedValueOnce([
        {
          id: 'c1',
          websiteId: 'w1',
          email: 'a@b.co',
          firstName: 'A',
          lastName: 'B',
          phone: '+84901',
          status: 'ACTIVE',
          acceptsMarketing: true,
          localeCode: 'vi-VN',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          lastLoginAt: null,
          customerGroup: { code: 'general' },
        },
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportCustomersJob(prisma as never, fakeStores() as never);
    expect(
      await job.validate({ website: 'us', acceptsMarketing: true }),
    ).toEqual({ website: 'us', acceptsMarketing: true });
    await expect(job.validate({ website: 'mars' })).rejects.toThrow(
      'Unknown website mars',
    );
    await expect(job.validate({ acceptsMarketing: 'yes' })).rejects.toThrow(
      'true or false',
    );
    const out = await job.run(
      jobContext('', { params: { website: 'us', acceptsMarketing: true } }),
    );
    expect(prisma.customer.count.mock.calls[0][0].where).toEqual({
      websiteId: 'w1',
      acceptsMarketing: true,
    });
    expect(lines(out)[1]).toBe(
      'us,a@b.co,A,B,+84901,general,ACTIVE,true,vi-VN,2026-01-01T00:00:00.000Z,',
    );
    expect(out.output!.name).toMatch(/^customers-us-/);
  });

  it('orders with totals as decimals, by window, store and status', async () => {
    const prisma = fakePrisma();
    prisma.order.findMany
      .mockResolvedValueOnce([
        {
          id: 'o1',
          number: 'US-000001',
          placedAt: new Date('2026-11-20T10:00:00Z'),
          storeId: 's1',
          status: 'COMPLETE',
          paymentStatus: 'PAID',
          fulfillmentStatus: 'FULFILLED',
          email: 'a@b.co',
          customerGroupCode: 'guest',
          currencyCode: 'USD',
          subtotal: 6200n,
          discountTotal: 620n,
          shippingTotal: 0n,
          taxTotal: 531n,
          grandTotal: 6111n,
          loyaltyAmount: 0n,
          amountPaid: 6111n,
          amountRefunded: 2464n,
          couponCode: 'WELCOME10',
          shippingMethodName: 'Standard',
          items: [{ quantity: 2 }, { quantity: 1 }],
          addresses: [{ countryCode: 'US' }],
        },
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportOrdersJob(prisma as never, fakeStores() as never);
    expect(
      await job.validate({ sinceHours: 24, store: 'us', status: 'COMPLETE' }),
    ).toEqual({ sinceHours: 24, store: 'us', status: 'COMPLETE' });
    const refused: [Record<string, unknown>, string][] = [
      [{ from: '2026-11-02', to: '2026-11-01' }, 'from must be before to'],
      [{ sinceHours: 0 }, 'whole number of hours'],
      [{ sinceHours: 2, from: '2026-11-01' }, 'not both'],
      [{ store: 'mars' }, 'Unknown store mars'],
      [{ status: 'LOST' }, 'status must be one of'],
    ];
    for (const [p, msg] of refused)
      await expect(job.validate(p)).rejects.toThrow(msg);
    const out = await job.run(
      jobContext('', {
        params: {
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-12-01T00:00:00.000Z',
          store: 'us',
          status: 'COMPLETE',
        },
      }),
    );
    expect(lines(out)[1]).toBe(
      'US-000001,2026-11-20T10:00:00.000Z,us,COMPLETE,PAID,FULFILLED,a@b.co,guest,USD,62.00,6.20,0.00,5.31,61.11,0.00,61.11,24.64,3,WELCOME10,Standard,US',
    );
    expect(prisma.order.count.mock.calls[0][0].where).toEqual({
      placedAt: {
        gte: new Date('2026-11-01T00:00:00Z'),
        lt: new Date('2026-12-01T00:00:00Z'),
      },
      storeId: 's1',
      status: 'COMPLETE',
    });
    prisma.order.findMany.mockResolvedValue([]);
    const before = Date.now();
    await job.run(jobContext('', { params: { sinceHours: 2 } }));
    const since =
      prisma.order.count.mock.calls[1][0].where.placedAt.gte.getTime();
    expect(before - since).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
  });

  it('audit log for a period, by entity or action prefix', async () => {
    const prisma = fakePrisma();
    prisma.auditLog.findMany
      .mockResolvedValueOnce([
        {
          id: 'a1',
          createdAt: new Date('2026-11-20T00:00:00Z'),
          actorType: 'admin',
          actorLabel: 'root',
          action: 'auth.login-failed',
          entityType: 'admin_user',
          entityId: 'u1',
          requestId: 'r1',
          ip: '1.2.3.4',
          changes: { email: 'x' },
        },
      ])
      .mockResolvedValueOnce([]);
    const job = new ExportAuditLogJob(prisma as never);
    await expect(job.validate({ from: '2026-11-01' })).rejects.toThrow(
      'from and to are required',
    );
    await expect(
      job.validate({ from: '2026-11-02', to: '2026-11-01' }),
    ).rejects.toThrow('before');
    const p = await job.validate({
      from: '2026-11-01',
      to: '2026-12-01',
      action: 'auth.',
      entityType: 'admin_user',
    });
    const out = await job.run(jobContext('', { params: p }));
    expect(prisma.auditLog.count.mock.calls[0][0].where).toMatchObject({
      action: { startsWith: 'auth.' },
      entityType: 'admin_user',
    });
    expect(lines(out)[1]).toBe(
      '2026-11-20T00:00:00.000Z,admin,root,auth.login-failed,admin_user,u1,r1,1.2.3.4,"{""email"":""x""}"',
    );
    expect(out.output!.name).toBe('audit-log-2026-11-01-2026-12-01.csv');
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await job.run(
      jobContext('', {
        params: { from: p.from, to: p.to, action: 'auth.login-failed' },
      }),
    );
    expect(prisma.auditLog.count.mock.calls[1][0].where.action).toBe(
      'auth.login-failed',
    );
  });

  it('exports stop when cancelled', async () => {
    const prisma = fakePrisma();
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        items: [],
        addresses: [],
        currencyCode: 'USD',
        subtotal: 0n,
        discountTotal: 0n,
        shippingTotal: 0n,
        taxTotal: 0n,
        grandTotal: 0n,
        loyaltyAmount: 0n,
        amountPaid: 0n,
        amountRefunded: 0n,
      },
    ]);
    const job = new ExportOrdersJob(prisma as never, fakeStores() as never);
    await expect(
      job.run(jobContext('', { cancelRequested: vi.fn(async () => true) })),
    ).rejects.toBeInstanceOf(JobCanceledError);
  });
});

describe('reindex jobs', () => {
  it('search: some or every website', async () => {
    const prisma = fakePrisma();
    const search = { reindexWebsites: vi.fn() };
    const job = new SearchReindexJob(prisma as never, search as never);
    prisma.website.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    expect(await job.validate({ websiteIds: [U(1)] })).toEqual({
      websiteIds: [U(1)],
    });
    await expect(job.validate({ websiteIds: [U(1), U(2)] })).rejects.toThrow(
      'Some websites do not exist',
    );
    expect(await job.validate({})).toEqual({});
    expect(
      await job.run(jobContext('', { params: { websiteIds: [U(1)] } })),
    ).toEqual({ stats: { websites: 1 } });
    expect(await job.run(jobContext())).toEqual({ stats: { websites: 2 } });
    expect(search.reindexWebsites).toHaveBeenLastCalledWith(undefined);
  });

  it('storefront URLs: some or every store', async () => {
    const prisma = fakePrisma();
    const rewrites = {
      enqueueStoreRebuild: vi.fn(async (ids?: string[]) => ids ?? ['s1', 's2']),
    };
    const job = new UrlRewritesRebuildJob(prisma as never, rewrites as never);
    prisma.store.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await job.validate({ storeIds: [U(3)] })).toEqual({
      storeIds: [U(3)],
    });
    await expect(job.validate({ storeIds: [U(4)] })).rejects.toThrow(
      'Some stores do not exist',
    );
    expect(await job.validate({})).toEqual({});
    expect(await job.run(jobContext())).toEqual({ stats: { stores: 2 } });
  });
});

describe('fake store helper', () => {
  it('builds a snapshot', async () => {
    expect((await fakeStores(storeSnap()).snapshot()).byCode.has('us')).toBe(
      true,
    );
  });
});
