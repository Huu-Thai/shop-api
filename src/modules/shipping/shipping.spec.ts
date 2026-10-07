import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { ROOT } from '../../testing/principals.js';
import { ShippingMethodsController } from './shipping.controller.js';
import {
  assertAmounts,
  ShippingMethodsService,
} from './shipping-methods.service.js';
import { shippingCharge } from './shipping-rates.js';
import { ShippingQuery } from './shipping.query.js';

const flat = {
  rateType: 'FLAT' as const,
  amounts: { USD: 799 },
  freeOver: { USD: 5000 },
  countryCodes: ['US'],
};
const cart = {
  currencyCode: 'USD',
  countryCode: 'US',
  units: 3,
  discountedSubtotal: 1000n,
};

describe('shippingCharge', () => {
  it('charges flat or per item, free over the threshold', () => {
    expect(shippingCharge(flat, cart)).toBe(799n);
    expect(shippingCharge({ ...flat, rateType: 'PER_ITEM' }, cart)).toBe(2397n);
    expect(
      shippingCharge({ ...flat, rateType: 'PER_ITEM' }, { ...cart, units: 0 }),
    ).toBe(799n);
    expect(shippingCharge(flat, { ...cart, discountedSubtotal: 5000n })).toBe(
      0n,
    );
    expect(
      shippingCharge(
        { ...flat, freeOver: null },
        { ...cart, discountedSubtotal: 9999n },
      ),
    ).toBe(799n);
  });

  it('does not serve other currencies or countries; any country before an address', () => {
    expect(
      shippingCharge(flat, { ...cart, currencyCode: 'VND' }),
    ).toBeUndefined();
    expect(
      shippingCharge(flat, { ...cart, countryCode: 'VN' }),
    ).toBeUndefined();
    expect(shippingCharge(flat, { ...cart, countryCode: null })).toBe(799n);
    expect(
      shippingCharge(
        { ...flat, countryCodes: [] },
        { ...cart, countryCode: 'VN' },
      ),
    ).toBe(799n);
  });
});

describe('assertAmounts', () => {
  it('accepts currency → non-negative integers only', () => {
    expect(() =>
      assertAmounts({ USD: 0, VND: 30000 }, 'amounts'),
    ).not.toThrow();
    for (const bad of [
      null,
      [],
      {},
      { usd: 1 },
      { USD: -1 },
      { USD: 1.5 },
      'x',
    ])
      expect(() => assertAmounts(bad, 'amounts')).toThrow('amounts must map');
  });
});

const row = (extra = {}) => ({
  id: 'm1',
  websiteId: 'w1',
  code: 'standard',
  carrier: 'ups',
  rateType: 'FLAT',
  amounts: { USD: 799 },
  freeOver: null,
  countryCodes: [],
  taxClassId: null,
  position: 0,
  isActive: true,
  translations: [{ localeCode: 'en-US', name: 'Standard', description: null }],
  ...extra,
});

describe('ShippingMethodsService', () => {
  function setup() {
    const prisma = fakePrisma();
    const b = fakeBus(prisma);
    return {
      prisma,
      b,
      svc: new ShippingMethodsService(prisma as never, b.bus),
    };
  }

  it('lists and creates with defaults', async () => {
    const { prisma, b, svc } = setup();
    prisma.shippingMethod.findMany.mockResolvedValue([row()]);
    expect(
      (await svc.list('w1'))[0].translations[0].description,
    ).toBeUndefined();
    prisma.shippingMethod.create.mockResolvedValue(
      row({ freeOver: { USD: 5000 } }),
    );
    const r = await svc.create(
      {
        websiteId: 'w1',
        code: 'standard',
        carrier: 'ups',
        amounts: { USD: 799 },
        freeOver: { USD: 5000 },
        translations: [{ localeCode: 'en-US', name: 'Standard' }],
      },
      ROOT,
    );
    expect(r.freeOver).toEqual({ USD: 5000 });
    expect(prisma.shippingMethod.create.mock.calls[0][0].data).toMatchObject({
      rateType: 'FLAT',
      countryCodes: [],
      position: 0,
      isActive: true,
    });
    expect(b.afterNames()).toEqual(['shipping-method.created']);
    await expect(
      svc.create(
        {
          websiteId: 'w1',
          code: 'x',
          carrier: 'c',
          amounts: { USD: 1 },
          freeOver: { USD: -1 },
          translations: [],
        },
        ROOT,
      ),
    ).rejects.toThrow('freeOver');
  });

  it('updates translations and fields, emitting only real changes; clears freeOver', async () => {
    const { prisma, b, svc } = setup();
    prisma.shippingMethod.findUnique.mockResolvedValue(row());
    prisma.shippingMethod.update.mockResolvedValue(
      row({ amounts: { USD: 899 } }),
    );
    await svc.update(
      'm1',
      {
        amounts: { USD: 899 },
        freeOver: null,
        translations: [{ localeCode: 'en-US', name: 'Std' }],
      },
      ROOT,
    );
    expect(prisma.shippingMethodTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(b.afterNames()).toEqual(['shipping-method.updated']);
    prisma.shippingMethod.update.mockResolvedValue(row());
    await svc.update('m1', { freeOver: { USD: 100 } }, ROOT);
    expect(b.afterNames()).toHaveLength(1);
    prisma.shippingMethod.findUnique.mockResolvedValue(null);
    await expect(svc.update('m1', {}, ROOT)).rejects.toThrow('not found');
  });

  it('removes', async () => {
    const { prisma, b, svc } = setup();
    prisma.shippingMethod.findUnique.mockResolvedValue({ code: 'standard' });
    await svc.remove('m1', ROOT);
    expect(b.afterNames()).toEqual(['shipping-method.deleted']);
    prisma.shippingMethod.findUnique.mockResolvedValue(null);
    await expect(svc.remove('m1', ROOT)).rejects.toThrow('not found');
  });
});

describe('ShippingQuery', () => {
  it('offers the methods that serve the cart, translated', async () => {
    const prisma = fakePrisma();
    prisma.shippingMethod.findMany.mockResolvedValue([
      row(),
      row({ id: 'm2', code: 'express', amounts: { VND: 1 }, translations: [] }),
      row({ id: 'm3', code: 'pickup', translations: [] }),
    ]);
    const out = await new ShippingQuery(prisma as never).options({
      ...cart,
      websiteId: 'w1',
      localeChain: ['en-US'],
    });
    expect(out.map((o) => [o.code, o.name, o.amount])).toEqual([
      ['standard', 'Standard', 799n],
      ['pickup', 'pickup', 799n],
    ]);
  });
});

describe('ShippingMethodsController', () => {
  it('delegates every route', async () => {
    const r = await exerciseController(
      new ShippingMethodsController(stubService() as never),
    );
    expect(r.failed).toBe(0);
  });
});
