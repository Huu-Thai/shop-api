import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../database/generated/prisma/client.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { TaxCacheListener } from './tax-cache.listener.js';
import { TaxClassUsageListener } from './tax-class.listener.js';
import { TaxController } from './tax.controller.js';
import { TaxQuery, toTaxResultDto } from './tax.query.js';
import { TaxService } from './tax.service.js';

const rateRow = (o: object = {}) => ({
  id: 'r1',
  zoneId: 'z',
  productTaxClassId: 'std',
  customerTaxClassId: null,
  name: 'VAT',
  rate: new Prisma.Decimal('19'),
  priority: 0,
  isCompound: false,
  validFrom: new Date('1970-01-01'),
  validTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

describe('TaxQuery', () => {
  function setup() {
    const prisma = fakePrisma();
    prisma.taxZone.findMany.mockResolvedValue([
      {
        id: 'z',
        code: 'de',
        rounding: 'TOTAL',
        regions: [
          { countryCode: 'DE', regionCode: null, postcodePattern: null },
        ],
      },
    ]);
    prisma.taxRate.findMany.mockResolvedValue([rateRow()]);
    prisma.taxClass.findMany.mockResolvedValue([
      { id: 'std', code: 'standard' },
      { id: 'ret', code: 'retail' },
    ]);
    const redis = { get: vi.fn(async () => '1'), incr: vi.fn(async () => 2) };
    return { q: new TaxQuery(prisma as never, redis as never), prisma, redis };
  }

  it('loads definitions, resolves default classes and calculates', async () => {
    const { q } = setup();
    const d = await q.definitions();
    expect(d.zones[0].rounding).toBe('TOTAL');
    expect(d.rates[0].rate).toBe('19');
    expect(await q.classId(null, 'PRODUCT')).toBe('std');
    expect(await q.classId(null, 'CUSTOMER')).toBe('ret');
    expect(await q.classId('given', 'PRODUCT')).toBe('given');
    const r = await q.ratesFor({ countryCode: 'DE' }, 'std', 'ret');
    expect(Number(r.totals.tax)).toBe(190_000);
  });

  it('calculateDto works with class codes and plain numbers', async () => {
    const { q } = setup();
    const r = await q.calculateDto({
      destination: { countryCode: 'DE' },
      pricesIncludeTax: true,
      lines: [{ key: 'a', amount: 11900 }],
      date: '2026-01-01',
    });
    expect(r).toMatchObject({
      totals: { net: 10000, tax: 1900, gross: 11900 },
      zones: ['de'],
      rounding: 'TOTAL',
    });
    await expect(
      q.calculateDto({
        destination: { countryCode: 'DE' },
        pricesIncludeTax: true,
        lines: [{ key: 'a', amount: 1, productTaxClass: 'nope' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails loudly when a default class is missing; invalidates', async () => {
    const { q, prisma, redis } = setup();
    prisma.taxClass.findMany.mockResolvedValue([]);
    await expect(q.classId(null, 'PRODUCT')).rejects.toThrow('standard');
    await new TaxCacheListener(q).onTaxChanged();
    expect(redis.incr).toHaveBeenCalled();
  });

  it('maps results to numbers', () => {
    expect(
      toTaxResultDto({
        lines: [],
        totals: { net: 1n, tax: 2n, gross: 3n },
        taxes: [{ rateId: 'r', name: 'n', rate: '1.0000', amount: 2n }],
        zones: [],
        rounding: 'LINE',
      }),
    ).toEqual({
      lines: [],
      totals: { net: 1, tax: 2, gross: 3 },
      taxes: [{ rateId: 'r', name: 'n', rate: '1.0000', amount: 2 }],
      zones: [],
      rounding: 'LINE',
    });
  });
});

describe('TaxService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return { svc: new TaxService(prisma as never, fb.bus), prisma, ...fb };
  }

  it('classes: create, rename, protect defaults, delete', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.taxClass.create.mockResolvedValue({
      id: 'c',
      code: 'luxury',
      name: 'Luxury',
      type: 'PRODUCT',
    });
    await svc.createClass(
      { code: 'luxury', name: 'Luxury', type: 'PRODUCT' },
      ROOT,
    );
    prisma.taxClass.findUnique.mockResolvedValue({
      id: 'c',
      code: 'luxury',
      name: 'Luxury',
      type: 'PRODUCT',
    });
    prisma.taxClass.update.mockResolvedValue({
      id: 'c',
      code: 'luxury',
      name: 'Lux',
      type: 'PRODUCT',
    });
    await svc.updateClass('c', { name: 'Lux' }, ROOT);
    await svc.removeClass('c', ROOT);
    prisma.taxClass.findUnique.mockResolvedValue({ code: 'standard' });
    await expect(svc.removeClass('c', ROOT)).rejects.toThrow('default class');
    prisma.taxClass.findUnique.mockResolvedValue(null);
    await expect(
      svc.updateClass('x', { name: 'x' }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.removeClass('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(afterNames()).toEqual([
      'tax-class.created',
      'tax-class.updated',
      'tax-class.deleted',
    ]);
    await svc.classes();
  });

  it('zones: regions normalised, replaced on update', async () => {
    const { svc, prisma, afterNames } = setup();
    const zone = {
      id: 'z',
      code: 'us-ca',
      name: 'CA',
      rounding: 'LINE',
      regions: [{ countryCode: 'US', regionCode: 'CA', postcodePattern: null }],
    };
    prisma.taxZone.create.mockResolvedValue(zone);
    await svc.createZone(
      {
        code: 'us-ca',
        name: 'CA',
        regions: [{ countryCode: 'US', regionCode: 'CA' }],
      },
      ROOT,
    );
    expect(prisma.taxZone.create.mock.calls[0][0].data.regions.create).toEqual([
      { countryCode: 'US', regionCode: 'CA', postcodePattern: null },
    ]);
    prisma.taxZone.findUnique.mockResolvedValue(zone);
    prisma.taxZone.update.mockResolvedValue({ ...zone, rounding: 'TOTAL' });
    await svc.updateZone(
      'z',
      { rounding: 'TOTAL', regions: [{ countryCode: 'US' }] },
      ROOT,
    );
    await svc.removeZone('z', ROOT);
    prisma.taxZone.findUnique.mockResolvedValue(null);
    await expect(svc.updateZone('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.removeZone('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(afterNames()).toEqual([
      'tax-zone.created',
      'tax-zone.updated',
      'tax-zone.deleted',
    ]);
    await svc.zones();
  });

  it('rates: class kinds checked, effective dating, formatted output', async () => {
    const { svc, prisma, afterNames } = setup();
    const dto = {
      zoneId: 'z',
      productTaxClassId: 'std',
      customerTaxClassId: 'ret',
      name: 'VAT',
      rate: '19',
      validFrom: '2026-01-01',
    };
    await expect(
      svc.createRate({ ...dto, validTo: '2025-01-01' }, ROOT),
    ).rejects.toThrow('validTo must be after');
    prisma.taxClass.findMany.mockResolvedValue([
      { id: 'std', type: 'CUSTOMER' },
      { id: 'ret', type: 'CUSTOMER' },
    ]);
    await expect(svc.createRate(dto, ROOT)).rejects.toThrow(
      'PRODUCT tax class',
    );
    prisma.taxClass.findMany.mockResolvedValue([
      { id: 'std', type: 'PRODUCT' },
      { id: 'ret', type: 'PRODUCT' },
    ]);
    await expect(svc.createRate(dto, ROOT)).rejects.toThrow(
      'CUSTOMER tax class',
    );
    prisma.taxClass.findMany.mockResolvedValue([
      { id: 'std', type: 'PRODUCT' },
      { id: 'ret', type: 'CUSTOMER' },
    ]);
    prisma.taxRate.create.mockResolvedValue(
      rateRow({ customerTaxClassId: 'ret', validFrom: new Date('2026-01-01') }),
    );
    expect(await svc.createRate(dto, ROOT)).toMatchObject({
      rate: '19.0000',
      validFrom: '2026-01-01',
      validTo: null,
    });
    prisma.taxRate.findUnique.mockResolvedValue(rateRow());
    await expect(
      svc.updateRate('r1', { validTo: '1960-01-01' }, ROOT),
    ).rejects.toThrow('validTo must be after');
    prisma.taxRate.update.mockResolvedValue(
      rateRow({ validTo: new Date('2027-01-01') }),
    );
    expect(
      (await svc.updateRate('r1', { validTo: '2027-01-01' }, ROOT)).validTo,
    ).toBe('2027-01-01');
    await svc.removeRate('r1', ROOT);
    prisma.taxRate.findUnique.mockResolvedValue(null);
    await expect(svc.updateRate('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.removeRate('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(afterNames()).toEqual([
      'tax-rate.created',
      'tax-rate.updated',
      'tax-rate.deleted',
    ]);
    prisma.taxRate.findMany.mockResolvedValue([rateRow()]);
    expect((await svc.rates('z'))[0].rate).toBe('19.0000');
  });
});

describe('TaxClassUsageListener', () => {
  it('vetoes classes of the wrong kind or that do not exist', async () => {
    const prisma = fakePrisma();
    const l = new TaxClassUsageListener(prisma as never);
    await l.onProductWrite({ input: { slugs: [] } } as never);
    await expect(
      l.onProductWrite({ input: { taxClassId: 'x', slugs: [] } } as never),
    ).rejects.toThrow('does not exist');
    prisma.taxClass.findUnique.mockResolvedValue({ type: 'CUSTOMER' });
    await expect(
      l.onProductWrite({ input: { taxClassId: 'x', slugs: [] } } as never),
    ).rejects.toThrow('must be a PRODUCT');
    await l.onCustomerGroupWrite({ input: { taxClassId: 'x' } } as never);
  });
});

describe('TaxController', () => {
  it('delegates', async () => {
    const svc = new Proxy(
      {},
      { get: (_t, k) => vi.fn(async () => k) },
    ) as Record<string, ReturnType<typeof vi.fn>>;
    const query = { calculateDto: vi.fn(async () => 'calc') };
    const c = new TaxController(svc as never, query as never);
    const results = await Promise.all([
      c.classes(),
      c.createClass({} as never, ROOT),
      c.updateClass('i', {} as never, ROOT),
      c.removeClass('i', ROOT),
      c.zones(),
      c.createZone({} as never, ROOT),
      c.updateZone('i', {}, ROOT),
      c.removeZone('i', ROOT),
      c.rates('z'),
      c.createRate({} as never, ROOT),
      c.updateRate('i', {}, ROOT),
      c.removeRate('i', ROOT),
      c.calculate({} as never),
    ]);
    expect(results).toEqual([
      'classes',
      'createClass',
      'updateClass',
      'removeClass',
      'zones',
      'createZone',
      'updateZone',
      'removeZone',
      'rates',
      'createRate',
      'updateRate',
      'removeRate',
      'calc',
    ]);
  });
});
