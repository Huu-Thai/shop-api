import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { CampaignsService } from './campaigns.service.js';
import { CouponsProcessor } from './coupons.processor.js';
import { CouponsService } from './coupons.service.js';
import { CouponStatus } from './dto/marketing.dto.js';
import {
  CampaignsController,
  CouponsAndUsageController,
  PromotionsController,
} from './marketing.controllers.js';
import { MarketingListener } from './marketing.listener.js';
import { PromotionsQuery } from './promotions.query.js';
import { PromotionsService } from './promotions.service.js';
import { RedemptionsService } from './redemptions.service.js';

const q = (extra: object = {}) =>
  ({ page: 1, limit: 25, order: 'desc', skip: 0, ...extra }) as never;

function base() {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  const publisher = {
    change: vi.fn(async (..._a: unknown[]) => undefined),
    cancelSchedules: vi.fn(),
  };
  return { prisma, publisher, ...fb };
}

const campaignRow = (over: object = {}) => ({
  id: 'c',
  code: 'flash',
  name: 'Flash',
  description: null,
  status: 'DRAFT',
  publishedAt: null,
  unpublishedAt: null,
  budgetAmount: null,
  budgetCurrencyCode: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { promotions: 0 },
  ...over,
});

describe('CampaignsService', () => {
  it('CRUD, publishing, and no deleting a campaign that still has promotions', async () => {
    const { prisma, bus, publisher, afterNames } = base();
    const svc = new CampaignsService(prisma as never, bus, publisher as never);
    prisma.campaign.create.mockResolvedValue(
      campaignRow({ budgetAmount: 5000n }),
    );
    expect(
      (
        await svc.create(
          {
            code: 'flash',
            name: 'Flash',
            budgetAmount: 5000,
            budgetCurrencyCode: 'USD',
          },
          ROOT,
        )
      ).budgetAmount,
    ).toBe('5000');
    await svc.create({ code: 'x', name: 'X' }, ROOT);
    expect(
      prisma.campaign.create.mock.calls[1][0].data.budgetCurrencyCode,
    ).toBeNull();
    prisma.campaign.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('c', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.campaign.findUnique.mockResolvedValue(campaignRow());
    prisma.campaign.update
      .mockResolvedValueOnce(campaignRow({ name: 'New', budgetAmount: 1n }))
      .mockResolvedValueOnce(campaignRow());
    await svc.update(
      'c',
      { name: 'New', budgetAmount: 1, budgetCurrencyCode: 'USD' },
      ROOT,
    );
    await svc.update('c', { budgetAmount: null }, ROOT);
    expect(
      prisma.campaign.update.mock.calls[1][0].data.budgetAmount,
    ).toBeNull();
    prisma.campaign.findUnique.mockResolvedValueOnce(
      campaignRow({ _count: { promotions: 2 } }),
    );
    await expect(svc.remove('c', ROOT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.campaign.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('c', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.remove('c', ROOT);
    expect(publisher.cancelSchedules).toHaveBeenCalled();
    expect(afterNames()).toEqual([
      'campaign.created',
      'campaign.created',
      'campaign.updated',
      'campaign.deleted',
    ]);
    prisma.campaign.findMany.mockResolvedValue([campaignRow()]);
    await svc.list(q({ search: 'Fl', status: 'DRAFT' }));
    await svc.list(q());
    prisma.campaign.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('c')).rejects.toBeInstanceOf(NotFoundException);
    await svc.publish('c', 'publish', '2026-11-01T00:00:00Z', ROOT);
    await svc.publish('c', 'unpublish', undefined, ROOT);
    expect(publisher.change.mock.calls.map((c) => c[0])).toEqual([
      'campaign',
      'campaign',
    ]);
  });
});

const promoRow = (over: object = {}) => ({
  id: 'p',
  name: 'P',
  description: null,
  campaignId: null,
  status: 'PUBLISHED',
  publishedAt: null,
  unpublishedAt: null,
  priority: 0,
  stopFurther: false,
  requiresCoupon: true,
  conditions: [],
  actions: [{ type: 'free_shipping' }],
  usageLimit: null,
  usesPerCustomer: null,
  timesUsed: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  campaign: null,
  websites: [{ websiteId: 'w2' }, { websiteId: 'w1' }],
  translations: [],
  ...over,
});

describe('PromotionsService', () => {
  function setup() {
    const b = base();
    const customers = { groups: vi.fn(async () => [{ code: 'general' }]) };
    return {
      svc: new PromotionsService(
        b.prisma as never,
        b.bus,
        b.publisher as never,
        customers as never,
      ),
      ...b,
    };
  }

  it('validates rules and groups, and reports whether the promotion is active', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.create(
        { name: 'x', websiteIds: ['w'], conditions: [], actions: [] },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        {
          name: 'x',
          websiteIds: ['w'],
          conditions: [{ type: 'customer_group', groups: ['vip'] }],
          actions: [{ type: 'free_shipping' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('Unknown customer groups: vip');
    prisma.promotion.create.mockResolvedValue(promoRow());
    const p = await svc.create(
      {
        name: 'x',
        websiteIds: ['w1', 'w1'],
        conditions: [{ type: 'customer_group', groups: ['general'] }],
        actions: [{ type: 'free_shipping' }],
        labels: [{ localeCode: 'en-US', label: 'Free' }],
      },
      ROOT,
    );
    expect(p).toMatchObject({ websiteIds: ['w1', 'w2'], active: true });
    expect(
      prisma.promotion.create.mock.calls[0][0].data.websites.create,
    ).toEqual([{ websiteId: 'w1' }]);
    prisma.promotion.findUnique.mockResolvedValueOnce(
      promoRow({
        campaign: { status: 'DRAFT', publishedAt: null, unpublishedAt: null },
      }),
    );
    expect((await svc.get('p')).active).toBe(false);
  });

  it('updates rules, websites and labels; guards the coupon requirement', async () => {
    const { svc, prisma, after } = setup();
    prisma.promotion.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.promotion.findUnique.mockResolvedValue(promoRow());
    prisma.coupon.count.mockResolvedValueOnce(3);
    await expect(
      svc.update('p', { requiresCoupon: false }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.promotion.update.mockResolvedValueOnce(
      promoRow({
        priority: 5,
        actions: [{ type: 'percent_off_cart', percent: 5 }],
      }),
    );
    await svc.update(
      'p',
      {
        priority: 5,
        actions: [{ type: 'percent_off_cart', percent: 5 }],
        websiteIds: ['w1'],
        labels: [{ localeCode: 'en-US', label: 'L' }],
      },
      ROOT,
    );
    expect(prisma.promotionWebsite.deleteMany).toHaveBeenCalled();
    expect(prisma.promotionTranslation.createMany).toHaveBeenCalled();
    expect(
      Object.keys(
        (after[0] as never as { audit: { changes: object } }).audit.changes,
      ),
    ).toEqual(['priority', 'actions']);
    prisma.promotion.update.mockResolvedValueOnce(promoRow());
    await svc.update('p', { requiresCoupon: false }, ROOT);
    expect(after).toHaveLength(1);
  });

  it('deletes, lists and publishes', async () => {
    const { svc, prisma, publisher, afterNames } = setup();
    prisma.promotion.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('p', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.promotion.findUnique.mockResolvedValueOnce({ name: 'P' });
    await svc.remove('p', ROOT);
    expect(afterNames()).toEqual(['promotion.deleted']);
    prisma.promotion.findMany.mockResolvedValue([promoRow()]);
    await svc.list(q({ websiteId: 'w', search: 'x', campaignId: 'c' }));
    await svc.list(q());
    prisma.promotion.findUnique.mockResolvedValue(promoRow());
    await svc.publish('p', 'publish', undefined, ROOT);
    await svc.publish('p', 'unpublish', '2026-11-01T00:00:00Z', ROOT);
    expect(publisher.change).toHaveBeenCalledTimes(2);
  });
});

describe('CouponsService', () => {
  function setup() {
    const b = base();
    const queue = { add: vi.fn() };
    return {
      svc: new CouponsService(b.prisma as never, b.bus, queue as never),
      queue,
      ...b,
    };
  }

  it('creates coupons only for coupon promotions; generates batches in the background', async () => {
    const { svc, prisma, queue, afterNames } = setup();
    prisma.promotion.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.create('p', { code: 'SAVE10' }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.promotion.findUnique.mockResolvedValueOnce({
      requiresCoupon: false,
    });
    await expect(
      svc.create('p', { code: 'SAVE10' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.promotion.findUnique.mockResolvedValue({ requiresCoupon: true });
    prisma.coupon.create.mockResolvedValue({ id: 'c', code: 'SAVE10' });
    await svc.create(
      'p',
      { code: 'SAVE10', expiresAt: '2026-12-01T00:00:00Z' },
      ROOT,
    );
    await svc.create('p', { code: 'SAVE11' }, ROOT);
    const g = await svc.generate('p', { count: 50, prefix: 'bf-' }, ROOT);
    expect(queue.add).toHaveBeenCalledWith(
      'coupons-generate',
      expect.objectContaining({
        batchId: g.batchId,
        prefix: 'BF-',
        length: 10,
        usageLimit: 1,
      }),
      expect.objectContaining({ jobId: `coupons-${g.batchId}` }),
    );
    expect(afterNames()).toEqual([
      'coupon.created',
      'coupon.created',
      'coupon.created',
    ]);
  });

  it('generation continues after collisions and gives up eventually', async () => {
    const { svc, prisma } = setup();
    prisma.coupon.count.mockResolvedValueOnce(1);
    prisma.coupon.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const job = {
      promotionId: 'p',
      batchId: 'b',
      count: 3,
      prefix: 'X',
      length: 8,
      usageLimit: 1,
      usesPerCustomer: null,
      expiresAt: '2026-12-01T00:00:00Z',
    };
    expect(await svc.runGeneration(job)).toBe(3);
    prisma.coupon.count.mockResolvedValueOnce(0);
    prisma.coupon.createMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.runGeneration({ ...job, expiresAt: null }),
    ).rejects.toThrow('Could not generate unique codes');
  });

  it('updates and deletes coupons; lists them', async () => {
    const { svc, prisma, afterNames } = setup();
    await svc.list('p', q({ search: 'bf', batchId: 'b' }));
    await svc.list('p', q());
    prisma.coupon.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('c', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const coupon = {
      id: 'c',
      isActive: true,
      usageLimit: 5,
      usesPerCustomer: null,
      expiresAt: null,
      timesUsed: 3,
    };
    prisma.coupon.findUnique.mockResolvedValue(coupon);
    await expect(
      svc.update('c', { usageLimit: 2 }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.coupon.update
      .mockResolvedValueOnce({ ...coupon, isActive: false })
      .mockResolvedValueOnce(coupon);
    await svc.update(
      'c',
      { isActive: false, expiresAt: '2026-12-01T00:00:00Z' },
      ROOT,
    );
    await svc.update('c', { expiresAt: null }, ROOT);
    prisma.coupon.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('c', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.coupon.findUnique.mockResolvedValueOnce({
      code: 'X',
      promotionId: 'p',
    });
    await svc.remove('c', ROOT);
    expect(afterNames()).toEqual(['coupon.updated', 'coupon.deleted']);
  });
});

describe('PromotionsQuery', () => {
  const NOW = new Date('2026-10-04T12:00:00Z');
  const row = (id: string, extra: object = {}) => ({
    id,
    name: id,
    priority: 0,
    stopFurther: false,
    requiresCoupon: false,
    conditions: [],
    actions: [],
    usageLimit: null,
    usesPerCustomer: null,
    timesUsed: 0,
    translations: [],
    ...extra,
  });

  it('filters by limits and per-customer use, and unlocks coupon promotions', async () => {
    const prisma = fakePrisma();
    const pq = new PromotionsQuery(prisma as never);
    prisma.promotion.findMany.mockResolvedValue([
      row('open', { translations: [{ localeCode: 'en-US', label: 'Open!' }] }),
      row('full', { usageLimit: 2, timesUsed: 2 }),
      row('once', { usesPerCustomer: 1 }),
      row('coupon', { requiresCoupon: true }),
    ]);
    prisma.promotionUsage.groupBy.mockResolvedValue([
      { promotionId: 'once', _count: { _all: 1 } },
    ]);
    const none = await pq.cartRules({
      websiteId: 'w',
      customerId: 'cu',
      localeChain: ['en-US'],
      now: NOW,
    });
    expect(none.rules.map((r) => [r.id, r.label])).toEqual([['open', 'Open!']]);
    expect(none.coupon).toBeNull();

    const coupon = (extra: object = {}) => ({
      id: 'k',
      code: 'SAVE',
      promotionId: 'coupon',
      isActive: true,
      expiresAt: null,
      usageLimit: null,
      usesPerCustomer: null,
      timesUsed: 0,
      ...extra,
    });
    const status = async (c: unknown, customerId: string | null = null) => {
      prisma.coupon.findUnique.mockResolvedValueOnce(c);
      return await pq.cartRules({
        websiteId: 'w',
        customerId,
        couponCode: ' save ',
        localeChain: [],
        now: NOW,
      });
    };
    expect((await status(null)).coupon?.status).toBe(CouponStatus.NOT_FOUND);
    expect((await status(coupon({ isActive: false }))).coupon?.status).toBe(
      CouponStatus.INACTIVE,
    );
    expect(
      (await status(coupon({ promotionId: 'elsewhere' }))).coupon?.status,
    ).toBe(CouponStatus.INACTIVE);
    expect(
      (await status(coupon({ expiresAt: new Date('2026-01-01') }))).coupon
        ?.status,
    ).toBe(CouponStatus.EXPIRED);
    expect(
      (await status(coupon({ usageLimit: 1, timesUsed: 1 }))).coupon?.status,
    ).toBe(CouponStatus.USED_UP);
    expect((await status(coupon({ promotionId: 'full' }))).coupon?.status).toBe(
      CouponStatus.USED_UP,
    );
    prisma.promotionUsage.count.mockResolvedValueOnce(1);
    expect(
      (await status(coupon({ usesPerCustomer: 1 }), 'cu')).coupon?.status,
    ).toBe(CouponStatus.ALREADY_USED);
    expect(
      (await status(coupon({ promotionId: 'once' }), 'cu')).coupon?.status,
    ).toBe(CouponStatus.ALREADY_USED);
    prisma.promotionUsage.count.mockResolvedValueOnce(0);
    const ok = await status(coupon({ usesPerCustomer: 1 }), 'cu');
    expect(ok.coupon?.status).toBe(CouponStatus.APPLIED);
    expect(ok.rules.find((r) => r.id === 'coupon')?.couponCode).toBe('SAVE');
  });
});

describe('RedemptionsService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const promotions = {
      cartRules: vi.fn(async () => ({
        rules: [
          {
            id: 'p1',
            label: 'Ten',
            priority: 0,
            stopFurther: false,
            conditions: [],
            actions: [{ type: 'percent_off_cart', percent: 10 }],
            couponCode: 'SAVE',
          },
        ],
        coupon: {
          code: 'SAVE',
          status: CouponStatus.APPLIED,
          message: 'ok',
          couponId: 'k',
          promotionId: 'p1',
        },
      })) as ReturnType<typeof vi.fn>,
    };
    const products = {
      cartFacts: vi.fn(
        async () =>
          new Map([
            ['A', { productId: 'pa', variantId: 'va', categoryIds: [] }],
          ]),
      ),
    };
    const customers = { groupOfCustomer: vi.fn(async () => 'wholesale') };
    const stores = {
      snapshot: vi.fn(async () => ({ fallbacks: new Map([['en-US', null]]) })),
    };
    return {
      svc: new RedemptionsService(
        prisma as never,
        fb.bus,
        promotions as never,
        products as never,
        customers as never,
        stores as never,
      ),
      prisma,
      promotions,
      customers,
      ...fb,
    };
  }
  const input = (extra: object = {}) => ({
    websiteId: 'w',
    currencyCode: 'USD',
    couponCode: 'SAVE',
    items: [
      { sku: 'A', quantity: 1, unitPrice: 1000 },
      { sku: 'A', quantity: 1, unitPrice: 1000 },
      { sku: 'GONE', quantity: 1, unitPrice: 5 },
    ],
    ...extra,
  });

  it('evaluates carts: merges SKUs, ignores unknown ones, resolves the customer group', async () => {
    const { svc, customers, promotions } = setup();
    const e = await svc.evaluate(
      input({ customerId: 'cu', localeCode: 'en-US', shippingAmount: 300 }),
    );
    expect(e).toMatchObject({
      subtotal: '2000',
      discountTotal: '200',
      lines: [{ sku: 'A', quantity: 2, lineTotal: '2000', discount: '200' }],
      unknownSkus: ['GONE'],
      coupon: { status: 'APPLIED' },
    });
    expect(customers.groupOfCustomer).toHaveBeenCalledWith('cu');
    promotions.cartRules.mockResolvedValueOnce({
      rules: [],
      coupon: {
        code: 'SAVE',
        status: CouponStatus.APPLIED,
        message: 'ok',
        couponId: 'k',
        promotionId: 'p1',
      },
    });
    expect(
      (await svc.evaluate(input({ customerGroupCode: 'guest' }))).coupon
        ?.status,
    ).toBe('NOT_APPLICABLE');
    promotions.cartRules.mockResolvedValueOnce({ rules: [], coupon: null });
    expect(
      (await svc.evaluate(input({ couponCode: undefined }))).coupon,
    ).toBeNull();
  });

  it('redeems once per order, claiming limits atomically', async () => {
    const { svc, prisma, promotions, afterNames } = setup();
    prisma.promotionUsage.findMany.mockResolvedValueOnce([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ usesPerCustomer: 1 }])
      .mockResolvedValueOnce([{ usesPerCustomer: null }]);
    prisma.promotionUsage.count.mockResolvedValueOnce(0);
    prisma.promotionUsage.create.mockImplementation(async ({ data }) => ({
      id: 'u',
      createdAt: new Date(),
      status: 'APPLIED',
      ...data,
    }));
    const r = await svc.redeem(
      { ...input(), customerId: 'cu', orderRef: 'O1' },
      SYSTEM_ACTOR,
    );
    expect(r.usages).toEqual([
      expect.objectContaining({
        promotionId: 'p1',
        couponId: 'k',
        discount: '200',
      }),
    ]);
    expect(afterNames()).toEqual(['promotion.redeemed']);
    // Already redeemed: the stored uses come back.
    prisma.promotionUsage.findMany.mockResolvedValueOnce([
      {
        id: 'u',
        promotionId: 'p1',
        couponId: 'k',
        customerId: null,
        orderRef: 'O1',
        discount: 200n,
        currencyCode: 'USD',
        status: 'APPLIED',
        createdAt: new Date(),
      },
    ]);
    expect(
      (await svc.redeem({ ...input(), orderRef: 'O1' }, SYSTEM_ACTOR)).usages[0]
        .discount,
    ).toBe('200');
    // A coupon that no longer applies, a used-up promotion, a used-up coupon, per-customer limits.
    promotions.cartRules.mockResolvedValueOnce({
      rules: [],
      coupon: {
        code: 'SAVE',
        status: CouponStatus.EXPIRED,
        message: 'expired',
        couponId: 'k',
        promotionId: 'p1',
      },
    });
    await expect(
      svc.redeem({ ...input(), orderRef: 'O2' }, SYSTEM_ACTOR),
    ).rejects.toThrow('expired');
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      svc.redeem({ ...input(), orderRef: 'O3' }, SYSTEM_ACTOR),
    ).rejects.toThrow('no longer available');
    prisma.$queryRaw.mockResolvedValueOnce([{ usesPerCustomer: 1 }]);
    prisma.promotionUsage.count.mockResolvedValueOnce(1);
    await expect(
      svc.redeem(
        { ...input(), customerId: 'cu', orderRef: 'O4' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow('already used this promotion');
    prisma.$queryRaw
      .mockResolvedValueOnce([{ usesPerCustomer: null }])
      .mockResolvedValueOnce([]);
    await expect(
      svc.redeem({ ...input(), orderRef: 'O5' }, SYSTEM_ACTOR),
    ).rejects.toThrow('used up');
    prisma.$queryRaw
      .mockResolvedValueOnce([{ usesPerCustomer: null }])
      .mockResolvedValueOnce([{ usesPerCustomer: 1 }]);
    prisma.promotionUsage.count.mockResolvedValueOnce(1);
    await expect(
      svc.redeem(
        { ...input(), customerId: 'cu', orderRef: 'O6' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow('already used this coupon');
    // Nothing applies: nothing to record.
    promotions.cartRules.mockResolvedValueOnce({ rules: [], coupon: null });
    expect(
      (
        await svc.redeem(
          { ...input({ couponCode: undefined }), orderRef: 'O7' },
          SYSTEM_ACTOR,
        )
      ).usages,
    ).toEqual([]);
  });

  it('releases a cancelled order’s uses (idempotent), 404 for unknown orders', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: 'u', promotionId: 'p1', couponId: 'k' },
      { id: 'v', promotionId: 'p2', couponId: null },
    ]);
    await svc.release('O1', SYSTEM_ACTOR);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(afterNames()).toEqual(['promotion.released']);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    prisma.promotionUsage.count.mockResolvedValueOnce(2);
    await svc.release('O1', SYSTEM_ACTOR);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(svc.release('X', SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.usages('O1');
  });
});

describe('marketing wiring', () => {
  it('controllers delegate; due schedules and coupon jobs reach their services', async () => {
    for (const C of [
      CampaignsController,
      PromotionsController,
      CouponsAndUsageController,
    ]) {
      const ctrl = new (C as new (...a: unknown[]) => object)(
        stubService(),
        stubService(),
        stubService(),
      );
      expect((await exerciseController(ctrl)).failed).toBe(0);
    }
    const publisher = { due: vi.fn() };
    const l = new MarketingListener(publisher as never);
    for (const targetType of ['CAMPAIGN', 'PROMOTION', 'PAGE'])
      await l.onDue({
        data: { targetType, targetId: 't', action: 'PUBLISH' },
      } as never);
    expect(publisher.due.mock.calls.map((c) => c[0])).toEqual([
      'campaign',
      'promotion',
    ]);
    const coupons = { runGeneration: vi.fn(async () => 7) };
    const proc = new CouponsProcessor(coupons as never);
    expect(
      await proc.process({ name: 'coupons-generate', data: {} } as never),
    ).toEqual({ created: 7 });
    expect(await proc.process({ name: 'x', data: {} } as never)).toEqual({
      skipped: 'unknown job x',
    });
  });
});
