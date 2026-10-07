/**
 * Phase 5 "done": a campaign activates promotions and coupons; points earn, redeem, expire and
 * reverse on refund. Also: storefront accounts (sessions, addresses, group prices) and coupon limits
 * under concurrency. Real API + worker against PostgreSQL, password-protected Redis and MinIO.
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { LoyaltyService } from '../src/modules/loyalty/loyalty.service.js';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service.js';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const PASSWORD = 'Correct-Horse-42!';
const DAY = 86_400_000;

describe('Customers, marketing and loyalty (e2e)', () => {
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
  const store = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    opts: { code?: string; bearer?: string; body?: object } = {},
  ) => {
    const r = http()
      [method](`/api/v1/store${path}`)
      .set('x-store', opts.code ?? 'us-en');
    if (opts.bearer) r.auth(opts.bearer, { type: 'bearer' });
    return opts.body ? r.send(opts.body) : r;
  };
  const cart = (extra: object = {}) => ({
    websiteId: id.us,
    currencyCode: 'USD',
    items: [
      { sku: 'TEE', quantity: 2, unitPrice: 2500 },
      { sku: 'MUG', quantity: 1, unitPrice: 1000 },
    ],
    ...extra,
  });
  const evaluate = (extra: object = {}) =>
    admin('post', '/marketing/promotions/evaluate', cart(extra)).expect(200);

  beforeAll(async () => {
    stack = await startStack();
    app = await startApp();
    worker = await startWorker(['price-index']);
    token = await rootToken(app);

    id.us = (
      await admin('post', '/websites', {
        code: 'us',
        name: 'US',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    id.uk = (
      await admin('post', '/websites', {
        code: 'uk',
        name: 'UK',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    for (const [code, websiteId] of [
      ['us-en', id.us],
      ['uk-en', id.uk],
    ])
      await admin('post', '/stores', {
        websiteId,
        code,
        name: code,
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'US',
      }).expect(201);
    id.tees = (
      await admin('post', '/categories', {
        translations: [{ localeCode: 'en-US', name: 'Tees' }],
        websiteIds: [id.us],
      }).expect(201)
    ).body.id;
    id.tee = (
      await admin('post', '/products', {
        sku: 'TEE',
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name: 'Tee' }],
        websiteIds: [id.us],
        categories: [{ categoryId: id.tees }],
      }).expect(201)
    ).body.id;
    await admin('post', '/products', {
      sku: 'MUG',
      type: 'SIMPLE',
      translations: [{ localeCode: 'en-US', name: 'Mug' }],
      websiteIds: [id.us],
    }).expect(201);
    const groups = (await admin('get', '/customer-groups').expect(200))
      .body as Body[];
    const book = async (o: object) =>
      (await admin('post', '/price-books', o).expect(201)).body.id as string;
    const list = await book({
      code: 'us-list',
      name: 'US list',
      currencyCode: 'USD',
      websiteId: id.us,
    });
    await admin('put', `/price-books/${list}/entries`, {
      entries: [
        { sku: 'TEE', amount: 2500 },
        { sku: 'MUG', amount: 1000 },
      ],
    }).expect(200);
    const members = await book({
      code: 'us-members',
      name: 'Members',
      currencyCode: 'USD',
      websiteId: id.us,
      customerGroupId: groups.find((g) => g.code === 'general')!.id,
    });
    await admin('put', `/price-books/${members}/entries`, {
      entries: [{ sku: 'TEE', amount: 2000 }],
    }).expect(200);
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await stack?.stop();
  });

  describe('storefront accounts', () => {
    it('signs up, signs in per website, rotates refresh tokens and detects their reuse', async () => {
      const weak = await store('post', '/account/register', {
        body: {
          email: 'ann@example.com',
          password: 'short',
          firstName: 'Ann',
          lastName: 'Lee',
        },
      }).expect(400);
      expect(JSON.stringify(weak.body)).toContain('password');
      const reg = await store('post', '/account/register', {
        body: {
          email: 'Ann@Example.com',
          password: PASSWORD,
          firstName: 'Ann',
          lastName: 'Lee',
        },
      }).expect(200);
      expect(reg.headers['cache-control']).toBe('private, no-store');
      id.annAccess = reg.body.accessToken;
      await store('post', '/account/register', {
        body: {
          email: 'ann@example.com',
          password: PASSWORD,
          firstName: 'Ann',
          lastName: 'Lee',
        },
      }).expect(409);
      // The same e-mail is free on another website; the account doesn't work there.
      await store('post', '/account/login', {
        code: 'uk-en',
        body: { email: 'ann@example.com', password: PASSWORD },
      }).expect(401);
      await store('get', '/account', {
        code: 'uk-en',
        bearer: id.annAccess,
      }).expect(401);

      const me = await store('get', '/account', {
        bearer: id.annAccess,
      }).expect(200);
      expect(me.body).toMatchObject({
        email: 'ann@example.com',
        firstName: 'Ann',
        group: 'general',
      });
      id.ann = me.body.id;
      await store('get', '/account').expect(401);
      // An admin token is not a customer token.
      await store('get', '/account', { bearer: token }).expect(401);

      const login = await store('post', '/account/login', {
        body: { email: 'ANN@example.com', password: PASSWORD },
      }).expect(200);
      const refreshed = await store('post', '/account/refresh', {
        body: { refreshToken: login.body.refreshToken },
      }).expect(200);
      await store('get', '/account', {
        bearer: refreshed.body.accessToken,
      }).expect(200);
      // Replaying the rotated token ends that whole session.
      await store('post', '/account/refresh', {
        body: { refreshToken: login.body.refreshToken },
      }).expect(401);
      await store('get', '/account', {
        bearer: refreshed.body.accessToken,
      }).expect(401);
      await store('get', '/account', { bearer: id.annAccess }).expect(200);
    });

    it('manages the address book with one default of each kind', async () => {
      const add = (body: object) =>
        store('post', '/account/addresses', { bearer: id.annAccess, body });
      const home = await add({
        firstName: 'Ann',
        lastName: 'Lee',
        countryCode: 'us',
        regionCode: 'ca',
        city: 'Los Angeles',
        line1: '1 Main St',
      }).expect(200);
      expect(home.body).toMatchObject({
        countryCode: 'US',
        regionCode: 'CA',
        isDefaultShipping: true,
        isDefaultBilling: true,
      });
      const work = await add({
        firstName: 'Ann',
        lastName: 'Lee',
        countryCode: 'US',
        city: 'Pasadena',
        line1: '9 Office Rd',
        isDefaultShipping: true,
      }).expect(200);
      const list = await store('get', '/account/addresses', {
        bearer: id.annAccess,
      }).expect(200);
      expect(
        list.body.map((a: Body) => [
          a.city,
          a.isDefaultShipping,
          a.isDefaultBilling,
        ]),
      ).toEqual([
        ['Los Angeles', false, true],
        ['Pasadena', true, false],
      ]);
      await store('delete', `/account/addresses/${work.body.id}`, {
        bearer: id.annAccess,
      }).expect(200);
      // Someone else's address id is "not found".
      const bob = await store('post', '/account/register', {
        body: {
          email: 'bob@example.com',
          password: PASSWORD,
          firstName: 'Bob',
          lastName: 'Ray',
        },
      }).expect(200);
      id.bobAccess = bob.body.accessToken;
      await store('delete', `/account/addresses/${home.body.id}`, {
        bearer: id.bobAccess,
      }).expect(404);
    });

    it('signed-in shoppers see their group’s prices, never cached publicly', async () => {
      const guest = await eventually(
        () => store('get', `/products/${id.tee}`),
        (r) => r.body.price?.amount === 2500,
        20_000,
      );
      expect(guest.headers['cache-control']).toContain('public');
      expect(guest.headers.vary).toContain('Authorization');
      const member = await eventually(
        () => store('get', `/products/${id.tee}`, { bearer: id.annAccess }),
        (r) => r.body.price?.amount === 2000,
        20_000,
      );
      expect(member.headers['cache-control']).toBe('private, no-store');
      await store('get', `/products/${id.tee}`, {
        bearer: 'not-a-token',
      }).expect(401);
    });

    it('disabling an account or changing the password ends its sessions', async () => {
      await admin('patch', `/customers/${id.ann}`, {
        status: 'DISABLED',
      }).expect(200);
      await store('get', '/account', { bearer: id.annAccess }).expect(401);
      await store('post', '/account/login', {
        body: { email: 'ann@example.com', password: PASSWORD },
      }).expect(401);
      await admin('patch', `/customers/${id.ann}`, { status: 'ACTIVE' }).expect(
        200,
      );
      const login = await store('post', '/account/login', {
        body: { email: 'ann@example.com', password: PASSWORD },
      }).expect(200);
      id.annAccess = login.body.accessToken;
      await store('post', '/account/password', {
        bearer: id.annAccess,
        body: { currentPassword: PASSWORD, newPassword: `${PASSWORD}x` },
      }).expect(200);
      await store('get', '/account', { bearer: id.annAccess }).expect(401);
      id.annAccess = (
        await store('post', '/account/login', {
          body: { email: 'ann@example.com', password: `${PASSWORD}x` },
        }).expect(200)
      ).body.accessToken;
      const found = await admin('get', '/customers?search=ann').expect(200);
      expect(found.body.data.map((c: Body) => c.email)).toEqual([
        'ann@example.com',
      ]);
    });
  });

  describe('a campaign activates promotions and coupons', () => {
    it('promotions and coupons apply only while their campaign runs', async () => {
      id.campaign = (
        await admin('post', '/marketing/campaigns', {
          code: 'flash',
          name: 'Flash sale',
        }).expect(201)
      ).body.id;
      const promo = async (body: object) =>
        (
          await admin('post', '/marketing/promotions', {
            websiteIds: [id.us],
            campaignId: id.campaign,
            ...body,
          }).expect(201)
        ).body.id as string;
      id.teePromo = await promo({
        name: 'Tees 20% off',
        priority: 1,
        conditions: [
          {
            type: 'item_quantity_at_least',
            quantity: 2,
            filter: { categoryIds: [id.tees] },
          },
        ],
        actions: [
          {
            type: 'percent_off_items',
            percent: 20,
            filter: { categoryIds: [id.tees] },
          },
        ],
        labels: [{ localeCode: 'en-US', label: '20% off tees' }],
      });
      id.couponPromo = await promo({
        name: '$5 off with a code',
        priority: 2,
        requiresCoupon: true,
        conditions: [{ type: 'subtotal_at_least', amounts: { USD: 3000 } }],
        actions: [
          { type: 'fixed_off_cart', amounts: { USD: 500 } },
          { type: 'free_shipping' },
        ],
      });
      await admin('post', '/marketing/promotions', {
        name: 'Broken',
        websiteIds: [id.us],
        conditions: [{ type: 'customer_group', groups: ['nobody'] }],
        actions: [{ type: 'percent_off_cart', percent: 120 }],
      }).expect(400);
      await admin('post', `/marketing/promotions/${id.couponPromo}/coupons`, {
        code: 'FLASH5',
        usageLimit: 3,
      }).expect(201);
      for (const p of [id.teePromo, id.couponPromo])
        await admin('post', `/marketing/promotions/${p}/publish`, {}).expect(
          200,
        );

      // Promotions are published, but the campaign hasn't started: nothing applies.
      const before = await evaluate({ couponCode: 'flash5' });
      expect(before.body).toMatchObject({
        discountTotal: '0',
        coupon: { code: 'FLASH5', status: 'INACTIVE' },
      });
      await admin('post', `/marketing/campaigns/${id.campaign}/publish`, {
        at: inMs(2000),
      }).expect(200);
      await admin('post', `/marketing/campaigns/${id.campaign}/unpublish`, {
        at: inMs(30_000),
      }).expect(200);
      expect((await evaluate()).body.applied).toEqual([]);
      await sleep(2200);

      const during = await evaluate({
        couponCode: 'flash5',
        shippingAmount: 799,
        localeCode: 'en-US',
      });
      expect(during.body).toMatchObject({
        subtotal: '6000',
        // 20% of 5000 on tees = 1000, then $5 split over what is left (4000 + 1000).
        discountTotal: '1500',
        total: '4500',
        freeShipping: true,
        shippingDiscount: '799',
        coupon: { status: 'APPLIED' },
      });
      expect(
        during.body.applied.map((a: Body) => [a.label, a.discount]),
      ).toEqual([
        ['20% off tees', '1000'],
        ['$5 off with a code', '500'],
      ]);
      expect(during.body.lines).toEqual([
        { sku: 'TEE', quantity: 2, lineTotal: '5000', discount: '1400' },
        { sku: 'MUG', quantity: 1, lineTotal: '1000', discount: '100' },
      ]);
      const small = await evaluate({
        couponCode: 'FLASH5',
        items: [{ sku: 'MUG', quantity: 1, unitPrice: 1000 }],
      });
      expect(small.body.coupon.status).toBe('NOT_APPLICABLE');
      expect(
        (await evaluate({ couponCode: 'NOPE99' })).body.coupon.status,
      ).toBe('NOT_FOUND');

      // The scheduler records the start (audit trail), the campaign stays the gate.
      await app.get(SchedulerService).runDue();
      const c = await eventually(
        () => admin('get', `/marketing/campaigns/${id.campaign}`),
        (r) => r.body.status === 'PUBLISHED',
      );
      expect(c.body).toMatchObject({ visible: true, promotionCount: 2 });

      // Ending the campaign now switches its promotions and coupons off.
      await admin(
        'post',
        `/marketing/campaigns/${id.campaign}/unpublish`,
        {},
      ).expect(200);
      const after = await evaluate({ couponCode: 'FLASH5' });
      expect(after.body).toMatchObject({
        discountTotal: '0',
        coupon: { status: 'INACTIVE' },
      });
      expect(
        (await admin('get', `/marketing/promotions/${id.teePromo}`).expect(200))
          .body.active,
      ).toBe(false);
      // Restart for the next tests.
      await admin(
        'post',
        `/marketing/campaigns/${id.campaign}/publish`,
        {},
      ).expect(200);
    });

    it('records coupon use per order exactly up to its limit, even under concurrency', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          admin('post', '/marketing/redemptions', {
            ...cart({ couponCode: 'FLASH5' }),
            orderRef: `ORD-${i}`,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const won = results.find((r) => r.status === 200)!;
      // Idempotent per order.
      const again = await admin('post', '/marketing/redemptions', {
        ...cart({ couponCode: 'FLASH5' }),
        orderRef: won.body.usages[0].orderRef,
      }).expect(200);
      expect(again.body.usages).toHaveLength(2);
      expect(
        (await evaluate({ couponCode: 'FLASH5' })).body.coupon.status,
      ).toBe('USED_UP');
      // Cancelling an order gives the use back.
      await admin('post', '/marketing/redemptions/release', {
        orderRef: won.body.usages[0].orderRef,
      }).expect(200);
      expect(
        (await evaluate({ couponCode: 'FLASH5' })).body.coupon.status,
      ).toBe('APPLIED');
    });

    it('generates unique coupon codes in bulk', async () => {
      const w = await startWorker(['coupons']);
      try {
        const g = await admin(
          'post',
          `/marketing/promotions/${id.couponPromo}/coupons/generate`,
          { count: 250, prefix: 'bf-', length: 8 },
        ).expect(202);
        const listed = await eventually(
          () =>
            admin(
              'get',
              `/marketing/promotions/${id.couponPromo}/coupons?batchId=${g.body.batchId}&limit=200`,
            ),
          (r) => r.body.total === 250,
          20_000,
        );
        expect(listed.body.total).toBe(250);
        expect(
          listed.body.data.every((c: Body) => /^BF-[A-Z2-9]{8}$/.test(c.code)),
        ).toBe(true);
      } finally {
        await w.close();
      }
    });
  });

  describe('points earn, redeem, expire and reverse on refund', () => {
    const op = (what: string, body: object) =>
      admin('post', `/loyalty/customers/${id.ann}/${what}`, body);

    it('a program per website opens accounts for new customers', async () => {
      await admin('put', `/loyalty/programs/${id.us}`, {
        name: 'Rewards',
        currencyCode: 'USD',
        spendPerPoint: 100,
        pointValue: 1,
        minRedeemPoints: 100,
        maxRedeemPercent: 50,
        expiryDays: 365,
      }).expect(200);
      await admin('post', `/loyalty/programs/${id.us}/tiers`, {
        code: 'gold',
        name: 'Gold',
        thresholdPoints: 500,
        multiplierBp: 15000,
      }).expect(201);
      // Ann registered before the program existed: her account opens on first earning.
      await admin('get', `/loyalty/customers/${id.ann}`).expect(404);
      const carol = await store('post', '/account/register', {
        body: {
          email: 'carol@example.com',
          password: PASSWORD,
          firstName: 'Carol',
          lastName: 'Ng',
        },
      }).expect(200);
      const loyalty = await eventually(
        () =>
          store('get', '/account/loyalty', { bearer: carol.body.accessToken }),
        (r) => r.status === 200,
      );
      expect(loyalty.body).toMatchObject({
        programName: 'Rewards',
        balance: 0,
        pointsPerUnit: 1,
        tier: null,
        nextTier: { code: 'gold', pointsNeeded: 500, multiplier: 1.5 },
      });
    });

    it('earns once per order, reaches a tier, and earns faster there', async () => {
      const first = await op('earn', {
        orderRef: 'A-1',
        amount: 60_000,
        currencyCode: 'USD',
      }).expect(200);
      expect(first.body.transactions[0]).toMatchObject({
        type: 'EARN',
        points: 600,
      });
      expect(first.body.account).toMatchObject({
        balance: 600,
        tier: { code: 'gold' },
      });
      const again = await op('earn', {
        orderRef: 'A-1',
        amount: 60_000,
        currencyCode: 'USD',
      }).expect(200);
      expect(again.body.transactions).toEqual([]);
      const second = await op('earn', {
        orderRef: 'A-2',
        amount: 10_000,
        currencyCode: 'USD',
      }).expect(200);
      expect(second.body.transactions[0].points).toBe(150); // ×1.5 in Gold
      await op('earn', {
        orderRef: 'A-3',
        amount: 100,
        currencyCode: 'EUR',
      }).expect(400);
    });

    it('lists accounts with their customer, searchable by e-mail or name', async () => {
      const found = await admin('get', '/loyalty/accounts?search=ANN@').expect(
        200,
      );
      expect(found.body.total).toBe(1);
      expect(found.body.data[0]).toMatchObject({
        customerId: id.ann,
        balance: 750,
        customer: { email: 'ann@example.com' },
      });
      const none = await admin('get', '/loyalty/accounts?search=nobody').expect(
        200,
      );
      expect(none.body.total).toBe(0);
    });

    it('redeems within the rules and reverses a cancelled order exactly', async () => {
      await op('redeem', { orderRef: 'B-1', points: 50 }).expect(400); // below the minimum
      await op('redeem', {
        orderRef: 'B-1',
        points: 300,
        orderAmount: 500,
      }).expect(400); // > 50%
      await op('redeem', { orderRef: 'B-1', points: 10_000 }).expect(409);
      const r = await op('redeem', { orderRef: 'B-1', points: 300 }).expect(
        200,
      );
      expect(r.body).toMatchObject({ value: '300', account: { balance: 450 } });
      // Cancelling B-1 gives the 300 points back to the credits they came from.
      const back = await op('reverse', { orderRef: 'B-1' }).expect(200);
      expect(back.body.account.balance).toBe(750);
      const twice = await op('reverse', { orderRef: 'B-1' }).expect(200);
      expect(twice.body.transactions).toEqual([]);
    });

    it('reverses earned points in proportion to a refund, never more than earned', async () => {
      // Refund a third of order A-1 (600 points on $600): 200 points go.
      const part = await op('reverse', {
        orderRef: 'A-1',
        amount: 20_000,
      }).expect(200);
      expect(part.body.transactions[0]).toMatchObject({
        type: 'REVERSE',
        points: -200,
      });
      expect(part.body.account.balance).toBe(550);
      // Then the rest of the order: the remaining 400, not 600.
      const rest = await op('reverse', { orderRef: 'A-1' }).expect(200);
      expect(rest.body.transactions[0].points).toBe(-400);
      expect(rest.body.account).toMatchObject({ balance: 150, tier: null });
      await op('reverse', { orderRef: 'NOPE' }).expect(404);
    });

    it('expires points FIFO after their expiry date', async () => {
      await op('adjust', { points: 25, note: 'Goodwill' }).expect(200);
      const loyalty = app.get(LoyaltyService);
      expect(await loyalty.expireDue(new Date(Date.now() + 364 * DAY))).toBe(0);
      expect(await loyalty.expireDue(new Date(Date.now() + 366 * DAY))).toBe(
        175,
      );
      const acct = await admin('get', `/loyalty/customers/${id.ann}`).expect(
        200,
      );
      expect(acct.body.balance).toBe(0);
      const ledger = await admin(
        'get',
        `/loyalty/customers/${id.ann}/transactions?type=EXPIRE`,
      ).expect(200);
      expect(
        ledger.body.data.reduce((s: number, t: Body) => s + t.points, 0),
      ).toBe(-175);
      const me = await store('get', '/account/loyalty', {
        bearer: id.annAccess,
      }).expect(200);
      expect(me.body.recent[0].type).toBe('EXPIRE');
    });
  });
});
