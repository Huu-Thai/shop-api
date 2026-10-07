import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { InventoryController } from './inventory.controller.js';
import {
  InventoryProcessor,
  InventoryScheduler,
} from './inventory.processor.js';
import { InventoryQuery } from './inventory.query.js';
import { InventoryService } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

const products = (types: Record<string, string> = {}) => ({
  variantTaxInfo: vi.fn(
    async (ids: string[]) =>
      new Map(
        ids
          .filter((i) => i !== 'gone')
          .map((i) => [
            i,
            { taxClassId: null, productId: 'p', type: types[i] ?? 'SIMPLE' },
          ]),
      ),
  ),
  variantIdsBySku: vi.fn(
    async (skus: string[]) =>
      new Map(skus.filter((s) => s !== 'NOPE').map((s) => [s, `v-${s}`])),
  ),
});

describe('InventoryQuery', () => {
  it('sums salable stock over the website’s active sources; virtual goods are unmanaged', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([{ variant_id: 'tee', salable: 7 }]);
    const q = new InventoryQuery(
      prisma as never,
      products({ gc: 'GIFT_CARD' }) as never,
    );
    const m = await q.salable('w', ['tee', 'none', 'gc', 'gone']);
    expect(Object.fromEntries(m)).toEqual({
      tee: { managed: true, salable: 7, inStock: true },
      none: { managed: true, salable: 0, inStock: false },
      gc: { managed: false, salable: null, inStock: true },
    });
    expect(await q.salable('w', [])).toEqual(new Map());
    expect((await q.salable('w', ['gc'])).get('gc')?.managed).toBe(false);
    expect(await q.isManaged('gone')).toBeUndefined();
    expect(await q.isManaged('gc')).toBe(false);
  });
});

describe('InventoryService', () => {
  function setup(types: Record<string, string> = {}) {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new InventoryService(
        prisma as never,
        fb.bus,
        products(types) as never,
      ),
      prisma,
      ...fb,
    };
  }
  const stockRow = (o: object = {}) => ({
    sourceId: 's',
    variantId: 'v-TEE',
    quantity: 12,
    reserved: 2,
    safetyStock: 1,
    version: 4,
    source: { code: 'wh' },
    variant: { sku: 'TEE' },
    ...o,
  });

  it('sources and website links', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.inventorySource.create.mockResolvedValue({ id: 's' });
    await svc.createSource({ code: 'wh', name: 'WH', countryCode: 'US' }, ROOT);
    prisma.inventorySource.findUnique.mockResolvedValue({
      id: 's',
      code: 'wh',
      name: 'WH',
      countryCode: 'US',
      isActive: true,
    });
    prisma.inventorySource.update.mockResolvedValue({
      id: 's',
      code: 'wh',
      name: 'WH',
      countryCode: 'US',
      isActive: false,
    });
    prisma.inventory.findMany.mockResolvedValue([{ variantId: 'v1' }]);
    await svc.updateSource('s', { isActive: false }, ROOT);
    prisma.inventorySource.findUnique.mockResolvedValue(null);
    await expect(svc.updateSource('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.setWebsiteSources(
        'w',
        { sources: [{ sourceId: 'a' }, { sourceId: 'a' }] },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.websiteInventorySource.findMany.mockResolvedValue([
      { sourceId: 'a', priority: 0, source: { code: 'a' } },
    ]);
    expect(
      await svc.setWebsiteSources('w', { sources: [{ sourceId: 'a' }] }, ROOT),
    ).toEqual([{ sourceId: 'a', code: 'a', priority: 0 }]);
    expect(afterNames()).toEqual([
      'inventory-source.created',
      'inventory-source.updated',
      'inventory.changed',
      'inventory.website-sources-changed',
      'inventory.changed',
    ]);
    await svc.sources();
  });

  it('adjust: delta or count, ledger entry, version check, never below reserved', async () => {
    const { svc, prisma, after } = setup();
    prisma.$queryRaw.mockResolvedValue([
      { id: 'i', quantity: 10, reserved: 2, safety_stock: 1, version: 4 },
    ]);
    prisma.inventory.update.mockResolvedValue(stockRow());
    expect(
      await svc.adjust(
        { sourceId: 's', sku: 'TEE', delta: 2, note: 'PO-1' },
        ROOT,
      ),
    ).toMatchObject({ quantity: 12, salable: 9, sku: 'TEE', sourceCode: 'wh' });
    expect(prisma.inventoryMovement.create.mock.calls[0][0].data).toMatchObject(
      {
        delta: 2,
        quantityAfter: 12,
        reason: 'RECEIPT',
        note: 'PO-1',
        actorLabel: ROOT.label,
      },
    );
    await svc.adjust({ sourceId: 's', variantId: 'v', quantity: 9 }, ROOT);
    expect(prisma.inventoryMovement.create.mock.calls[1][0].data).toMatchObject(
      { delta: -1, reason: 'CORRECTION' },
    );
    await svc.adjust(
      { sourceId: 's', variantId: 'v', quantity: 10, safetyStock: 3 },
      ROOT,
    ); // no quantity change → no ledger row
    expect(prisma.inventoryMovement.create).toHaveBeenCalledTimes(2);
    expect(after.map((e) => e.name)).toContain('inventory.adjusted');
    await expect(
      svc.adjust({ sourceId: 's', variantId: 'v', quantity: 1 }, ROOT),
    ).rejects.toThrow('below the 2 unit(s) reserved');
    await expect(
      svc.adjust(
        { sourceId: 's', variantId: 'v', delta: 1, expectedVersion: 3 },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adjust input validation', async () => {
    const { svc } = setup({ 'v-GC': 'GIFT_CARD' });
    await expect(
      svc.adjust({ sourceId: 's', sku: 'TEE' }, ROOT),
    ).rejects.toThrow('Send delta or quantity');
    await expect(
      svc.adjust({ sourceId: 's', sku: 'TEE', delta: 1, quantity: 1 }, ROOT),
    ).rejects.toThrow('not both');
    await expect(
      svc.adjust({ sourceId: 's', sku: 'NOPE', delta: 1 }, ROOT),
    ).rejects.toThrow('Unknown SKU');
    await expect(svc.adjust({ sourceId: 's', delta: 1 }, ROOT)).rejects.toThrow(
      'variantId or sku',
    );
    await expect(
      svc.adjust({ sourceId: 's', variantId: 'gone', delta: 1 }, ROOT),
    ).rejects.toThrow('does not exist');
    await expect(
      svc.adjust({ sourceId: 's', sku: 'GC', delta: 1 }, ROOT),
    ).rejects.toThrow("don't keep stock");
  });

  it('lists stock and movements', async () => {
    const { svc, prisma } = setup();
    prisma.inventory.findMany.mockResolvedValue([stockRow()]);
    prisma.inventory.count.mockResolvedValue(1);
    expect(
      (
        await svc.stock({
          page: 1,
          limit: 10,
          skip: 0,
          order: 'desc',
          sku: 'TEE',
        } as never)
      ).data[0],
    ).toMatchObject({ salable: 9, sourceCode: 'wh' });
    await svc.movements({
      page: 1,
      limit: 10,
      skip: 0,
      order: 'desc',
    } as never);
    expect(await svc.websiteSources('w')).toEqual([]);
  });
});

describe('ReservationsService', () => {
  function setup(types: Record<string, string> = {}) {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const inventory = {
      isManaged: vi.fn(async (id: string) =>
        id === 'gone' ? undefined : (types[id] ?? 'SIMPLE') === 'SIMPLE',
      ),
    };
    const svc = new ReservationsService(
      prisma as never,
      fb.bus,
      products(types) as never,
      inventory as never,
    );
    return { svc, prisma, ...fb };
  }
  const src = (
    sourceId: string,
    quantity: number,
    priority: number,
    reserved = 0,
  ) => ({
    inventoryId: `i-${sourceId}`,
    sourceId,
    quantity,
    reserved,
    safetyStock: 0,
    priority,
  });
  const res = (o: object = {}) => ({
    variantId: 'v',
    sourceId: 'a',
    quantity: 2,
    status: 'ACTIVE',
    expiresAt: new Date(),
    referenceType: 'CART',
    referenceId: 'c',
    ...o,
  });

  it('reserves by source priority under row locks', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.$queryRaw.mockResolvedValue([src('b', 10, 1), src('a', 3, 0, 1)]);
    const r = await svc.reserve(
      {
        variantId: 'v',
        websiteId: 'w',
        quantity: 5,
        referenceType: 'CART',
        referenceId: 'c',
        ttlSeconds: 60,
      },
      ROOT,
    );
    expect(r.lines).toEqual([
      { sourceId: 'a', quantity: 2 },
      { sourceId: 'b', quantity: 3 },
    ]);
    expect(prisma.$queryRaw.mock.calls[0][0].join('?')).toContain(
      'FOR UPDATE OF i',
    );
    expect(prisma.inventory.update).toHaveBeenCalledWith({
      where: { id: 'i-a' },
      data: { reserved: { increment: 2 }, version: { increment: 1 } },
    });
    expect(afterNames()).toEqual(['inventory.reserved', 'inventory.changed']);
    await expect(
      svc.reserve({
        variantId: 'v',
        websiteId: 'w',
        quantity: 50,
        referenceType: 'CART',
        referenceId: 'c',
      }),
    ).rejects.toThrow('Only 12 unit(s) available');
  });

  it('unmanaged goods reserve nothing; bad input is rejected', async () => {
    const { svc, prisma } = setup({ gc: 'GIFT_CARD' });
    expect(
      await svc.reserve({
        variantId: 'gc',
        websiteId: 'w',
        quantity: 3,
        referenceType: 'CART',
        referenceId: 'c',
      }),
    ).toMatchObject({ managed: false, lines: [], expiresAt: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await expect(
      svc.reserve({
        sku: 'NOPE',
        websiteId: 'w',
        quantity: 1,
        referenceType: 'CART',
        referenceId: 'c',
      }),
    ).rejects.toThrow('Unknown SKU');
    await expect(
      svc.reserve({
        websiteId: 'w',
        quantity: 1,
        referenceType: 'CART',
        referenceId: 'c',
      }),
    ).rejects.toThrow('variantId or sku');
    await expect(
      svc.reserve({
        variantId: 'gone',
        websiteId: 'w',
        quantity: 1,
        referenceType: 'CART',
        referenceId: 'c',
      }),
    ).rejects.toThrow('does not exist');
  });

  it('release gives stock back; convert sells it into the ledger; both idempotent', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.inventoryReservation.findMany.mockResolvedValue([res()]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: 'r', source_id: 'a', variant_id: 'v', quantity: 2 },
    ]);
    expect((await svc.release('g', ROOT)).status).toBe('RELEASED');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'r', source_id: 'a', variant_id: 'v', quantity: 2 },
      ])
      .mockResolvedValueOnce([{ quantity: 8 }]);
    expect((await svc.convert('g2', 'order-1', ROOT)).status).toBe('CONVERTED');
    expect(prisma.inventoryMovement.create.mock.calls[0][0].data).toMatchObject(
      { delta: -2, quantityAfter: 8, reason: 'SALE', reference: 'order-1' },
    );
    expect(afterNames()).toEqual([
      'inventory.released',
      'inventory.changed',
      'inventory.converted',
      'inventory.changed',
    ]);
    // Already finished:
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.inventoryReservation.findMany.mockResolvedValue([
      res({ status: 'RELEASED' }),
    ]);
    expect((await svc.release('g')).status).toBe('RELEASED');
    await expect(svc.convert('g', undefined)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.inventoryReservation.findMany.mockResolvedValue([
      res({ status: 'EXPIRED' }),
    ]);
    expect((await svc.release('g')).status).toBe('EXPIRED');
    prisma.inventoryReservation.findMany.mockResolvedValue([]);
    await expect(svc.release('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.get('missing')).rejects.toBeInstanceOf(NotFoundException);
    prisma.inventoryReservation.findMany.mockResolvedValue([
      res(),
      res({ sourceId: 'b', quantity: 1 }),
    ]);
    expect((await svc.get('g')).quantity).toBe(3);
  });

  it('expires overdue groups and tolerates concurrent finishes', async () => {
    const { svc, prisma } = setup();
    prisma.inventoryReservation.findMany.mockImplementation(
      async (args: { distinct?: string[] }) =>
        args.distinct
          ? [{ groupId: 'g1' }, { groupId: 'g2' }]
          : [res({ status: 'CONVERTED' })],
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'r', source_id: 'a', variant_id: 'v', quantity: 2 },
      ])
      .mockResolvedValueOnce([]);
    expect(await svc.expire(new Date())).toBe(1);
  });

  it('reconciles drift under the row lock', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'i1' }, { id: 'i2' }])
      .mockResolvedValueOnce([{ variant_id: 'v', source_id: 'a', reserved: 5 }])
      .mockResolvedValueOnce([{ active: 2 }])
      .mockResolvedValueOnce([{ variant_id: 'v', source_id: 'b', reserved: 1 }])
      .mockResolvedValueOnce([{ active: 1 }]);
    expect(await svc.reconcile()).toEqual({ checked: 2, fixed: 1 });
    expect(prisma.inventory.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { reserved: 2, version: { increment: 1 } },
    });
    expect(afterNames()).toEqual(['inventory.reconciled', 'inventory.changed']);
  });

  it('a caller-chosen group is reserved once (checkout retries)', async () => {
    const { svc, prisma } = setup();
    const dto = {
      websiteId: 'w',
      sku: 'S',
      quantity: 2,
      referenceType: 'ORDER',
      referenceId: 'o',
      groupId: 'g1',
    };
    prisma.inventoryReservation.findMany.mockResolvedValueOnce([
      res({ groupId: 'g1' }),
    ]);
    expect((await svc.reserve(dto as never)).groupId).toBe('g1');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    prisma.$queryRaw.mockResolvedValue([src('a', 10, 0)]);
    await svc.reserve(dto as never);
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('returns sold stock once per reference', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.inventoryReservation.findMany.mockResolvedValueOnce([]);
    expect(await svc.returnStock('g', 1, 'REFUND:r1')).toBe(0);
    const sold = [
      res({ sourceId: 'a', quantity: 1, status: 'CONVERTED' }),
      res({ sourceId: 'b', quantity: 2, status: 'CONVERTED' }),
      res({ sourceId: 'c', quantity: 2, status: 'CONVERTED' }),
    ];
    prisma.inventoryReservation.findMany.mockResolvedValue(sold);
    prisma.inventoryMovement.count.mockResolvedValueOnce(1);
    expect(await svc.returnStock('g', 2, 'REFUND:r1')).toBe(0);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 7 }]);
    expect(await svc.returnStock('g', 2, 'REFUND:r2')).toBe(2);
    expect(prisma.inventoryMovement.create.mock.calls[0][0].data).toMatchObject(
      {
        sourceId: 'b',
        delta: 2,
        quantityAfter: 7,
        reason: 'RETURN',
        reference: 'REFUND:r2',
      },
    );
    expect(afterNames()).toEqual(['inventory.changed']);
    prisma.$queryRaw.mockResolvedValue([]);
    expect(await svc.returnStock('g', 1, 'REFUND:r3')).toBe(0);
    expect(afterNames()).toHaveLength(1);
  });
});

describe('inventory jobs and controller', () => {
  it('processor and scheduler', async () => {
    const reservations = {
      expire: vi.fn(async () => 3),
      reconcile: vi.fn(async () => ({ checked: 0, fixed: 0 })),
    };
    const p = new InventoryProcessor(reservations as never);
    expect(
      await p.process({
        id: '1',
        name: 'inventory-expire-reservations',
        data: {},
      } as never),
    ).toEqual({ expired: 3 });
    expect(
      await p.process({
        id: '2',
        name: 'inventory-reconcile',
        data: {},
      } as never),
    ).toEqual({ checked: 0, fixed: 0 });
    expect(await p.process({ id: '3', name: 'x', data: {} } as never)).toEqual({
      skipped: 'unknown job x',
    });
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new InventoryScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
  });

  it('controller delegates', async () => {
    const inv = new Proxy(
      {},
      { get: (_t, k) => vi.fn(async () => k) },
    ) as never;
    const reservations = new Proxy(
      {},
      { get: (_t, k) => vi.fn(async () => `r:${String(k)}`) },
    ) as never;
    const query = {
      salable: vi.fn(
        async () =>
          new Map([['v', { managed: true, salable: 1, inStock: true }]]),
      ),
    };
    const c = new InventoryController(inv, reservations, query as never);
    expect(
      await Promise.all([
        c.sources(),
        c.createSource({} as never, ROOT),
        c.updateSource('s', {}, ROOT),
        c.websiteSources('w'),
        c.setWebsiteSources('w', {} as never, ROOT),
        c.stock({} as never),
        c.adjust({} as never, ROOT),
        c.movements({} as never),
        c.salable({ websiteId: 'w', variantIds: ['v'] }),
        c.reserve({} as never, ROOT),
        c.getReservation('g'),
        c.release('g', ROOT),
        c.convert('g', ROOT),
      ]),
    ).toEqual([
      'sources',
      'createSource',
      'updateSource',
      'websiteSources',
      'setWebsiteSources',
      'stock',
      'adjust',
      'movements',
      [{ variantId: 'v', managed: true, salable: 1, inStock: true }],
      'r:reserve',
      'r:get',
      'r:release',
      'r:convert',
    ]);
  });
});
