/**
 * Phase 6 "done": cart → order → payment (every provider, against local emulators of their sandbox
 * APIs) → shipment → refund, end to end. Real API + workers against PostgreSQL, password-protected
 * Redis and MinIO.
 */
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { CREDS, PaymentEmulator } from './support/payment-emulator.js';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PASSWORD = 'Correct-Horse-42!';

describe('Checkout (e2e)', () => {
  let stack: TestStack;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let token: string;
  const id: Record<string, string> = {};
  const emulator = new PaymentEmulator();

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
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    opts: {
      code?: string;
      cart?: string;
      bearer?: string;
      body?: object;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const r = http()
      [method](`/api/v1/store${path}`)
      .set('x-store', opts.code ?? 'us-en');
    if (opts.cart) r.set('x-cart-token', opts.cart);
    if (opts.bearer) r.auth(opts.bearer, { type: 'bearer' });
    for (const [k, v] of Object.entries(opts.headers ?? {})) r.set(k, v);
    return opts.body ? r.send(opts.body) : r;
  };
  const address = {
    firstName: 'Ann',
    lastName: 'Lee',
    countryCode: 'US',
    regionCode: 'CA',
    city: 'Los Angeles',
    postcode: '90001',
    line1: '1 Main St',
  };

  beforeAll(async () => {
    stack = await startStack();
    app = await startApp();
    worker = await startWorker(['price-index']);
    token = await rootToken(app);

    await admin('patch', '/locales/vi-VN', { isActive: true }).expect(200);
    await admin('patch', '/currencies/VND', { isActive: true }).expect(200);
    id.us = (
      await admin('post', '/websites', {
        code: 'us',
        name: 'US',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    id.vn = (
      await admin('post', '/websites', {
        code: 'vn',
        name: 'VN',
        baseCurrencyCode: 'VND',
      }).expect(201)
    ).body.id;
    id.usStore = (
      await admin('post', '/stores', {
        websiteId: id.us,
        code: 'us-en',
        name: 'US',
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
    id.vnStore = (
      await admin('post', '/stores', {
        websiteId: id.vn,
        code: 'vn-vi',
        name: 'VN',
        defaultLocaleCode: 'vi-VN',
        defaultCurrencyCode: 'VND',
        countryCode: 'VN',
        pricesIncludeTax: true,
      }).expect(201)
    ).body.id;

    // ── Tax: California 7.25% (exclusive store), Vietnam 10% (inclusive store).
    const classes = (await admin('get', '/tax/classes').expect(200))
      .body as Body[];
    id.standard = classes.find((c) => c.code === 'standard')!.id;
    for (const [code, regions, rate] of [
      ['us-ca', [{ countryCode: 'US', regionCode: 'CA' }], '7.25'],
      ['vn', [{ countryCode: 'VN' }], '10'],
    ] as const) {
      const zone = (
        await admin('post', '/tax/zones', { code, name: code, regions }).expect(
          201,
        )
      ).body.id;
      await admin('post', '/tax/rates', {
        zoneId: zone,
        productTaxClassId: id.standard,
        name: 'Tax',
        rate,
      }).expect(201);
    }

    // ── Catalog: a tee and a mug (physical), an e-book (virtual), a bundle of both.
    const product = async (sku: string, type = 'SIMPLE', extra: object = {}) =>
      (
        await admin('post', '/products', {
          sku,
          type,
          translations: [{ localeCode: 'en-US', name: sku }],
          websiteIds: [id.us, id.vn],
          ...extra,
        }).expect(201)
      ).body as Body;
    const tee = await product('TEE');
    id.teeVariant = tee.variants[0].id;
    const mug = await product('MUG');
    await product('EBOOK', 'VIRTUAL');
    await product('KIT', 'BUNDLE', {
      typeOptions: { priceType: 'DYNAMIC' },
      bundleOptions: [
        {
          code: 'shirt',
          inputType: 'RADIO',
          titles: [{ localeCode: 'en-US', title: 'Shirt' }],
          selections: [{ variantId: tee.variants[0].id, isDefault: true }],
        },
        {
          code: 'mug',
          inputType: 'CHECKBOX',
          isRequired: false,
          titles: [{ localeCode: 'en-US', title: 'Mug' }],
          selections: [
            { variantId: mug.variants[0].id, qty: 2, canChangeQty: true },
          ],
        },
      ],
    });
    const book = async (
      code: string,
      websiteId: string,
      currencyCode: string,
      entries: object[],
      includesTax = false,
    ) => {
      const b = (
        await admin('post', '/price-books', {
          code,
          name: code,
          currencyCode,
          websiteId,
          includesTax,
        }).expect(201)
      ).body.id;
      await admin('put', `/price-books/${b}/entries`, { entries }).expect(200);
    };
    await book('us', id.us, 'USD', [
      { sku: 'TEE', amount: 2500 },
      { sku: 'TEE', minQty: 5, amount: 2000 },
      { sku: 'MUG', amount: 1000 },
      { sku: 'EBOOK', amount: 900 },
    ]);
    await book(
      'vn',
      id.vn,
      'VND',
      [
        { sku: 'TEE', amount: 275000 },
        { sku: 'MUG', amount: 110000 },
      ],
      true,
    );

    // ── Stock: 10 tees and 10 mugs per website.
    for (const [code, websiteId, country] of [
      ['us-wh', id.us, 'US'],
      ['vn-wh', id.vn, 'VN'],
    ] as const) {
      const source = (
        await admin('post', '/inventory/sources', {
          code,
          name: code,
          countryCode: country,
        }).expect(201)
      ).body.id;
      await admin('put', `/websites/${websiteId}/inventory-sources`, {
        sources: [{ sourceId: source }],
      }).expect(200);
      for (const sku of ['TEE', 'MUG'])
        await admin('post', '/inventory/adjustments', {
          sourceId: source,
          sku,
          delta: 10,
        }).expect(200);
    }

    // ── Shipping: standard $7.99 (free over $100) and express per item; VN flat 30,000 ₫.
    await admin('post', '/shipping-methods', {
      websiteId: id.us,
      code: 'standard',
      carrier: 'ups',
      amounts: { USD: 799 },
      freeOver: { USD: 10_000 },
      taxClassId: id.standard,
      translations: [{ localeCode: 'en-US', name: 'Standard' }],
    }).expect(201);
    await admin('post', '/shipping-methods', {
      websiteId: id.us,
      code: 'express',
      carrier: 'fedex',
      rateType: 'PER_ITEM',
      amounts: { USD: 500 },
      countryCodes: ['US'],
      position: 1,
      translations: [{ localeCode: 'en-US', name: 'Express' }],
    }).expect(201);
    await admin('post', '/shipping-methods', {
      websiteId: id.vn,
      code: 'standard',
      carrier: 'ghn',
      amounts: { VND: 30_000 },
      translations: [{ localeCode: 'vi-VN', name: 'Tiêu chuẩn' }],
    }).expect(201);

    // ── Payments: every provider against the local sandbox emulator.
    await emulator.start();
    const provider = async (code: string, credentials?: object) =>
      (
        await admin('post', '/payment-providers', {
          code,
          name: code,
          mode: 'TEST',
          credentials,
        }).expect(201)
      ).body.id as string;
    id.stripe = await provider('STRIPE', {
      ...CREDS.stripe,
      apiBase: `${emulator.base}/stripe`,
    });
    id.paypal = await provider('PAYPAL', {
      ...CREDS.paypal,
      apiBase: `${emulator.base}/paypal`,
    });
    id.vnpay = await provider('VNPAY', {
      ...CREDS.vnpay,
      apiUrl: `${emulator.base}/vnpay/merchant_webapi/api/transaction`,
    });
    id.momo = await provider('MOMO', {
      ...CREDS.momo,
      apiBase: `${emulator.base}/momo`,
    });
    id.cod = await provider('COD');
    await admin('post', '/payment-providers', {
      code: 'STRIPE',
      name: 'bad',
      credentials: { secretKey: 'x' },
    }).expect(400);
    const method = (
      storeId: string,
      providerId: string,
      code: string,
      extra: object = {},
    ) =>
      admin('post', '/payment-methods', {
        storeId,
        providerId,
        code,
        titles: [{ localeCode: 'en-US', title: code }],
        ...extra,
      }).expect(201);
    await method(id.usStore, id.stripe, 'card');
    await method(id.usStore, id.paypal, 'paypal', { position: 1 });
    await method(id.usStore, id.cod, 'cod', {
      position: 2,
      maxAmounts: { USD: 50_000 },
    });
    await method(id.vnStore, id.vnpay, 'vnpay', { currencyCodes: ['VND'] });
    await method(id.vnStore, id.momo, 'momo', {
      position: 1,
      currencyCodes: ['VND'],
    });

    // Prices are indexed by the worker.
    await eventually(
      () => store('get', `/products/${tee.id}`),
      (r) => r.body.price?.amount === 2500,
      30_000,
    );
  });

  afterAll(async () => {
    await emulator.stop();
    await worker?.close();
    await app?.close();
    await stack?.stop();
  });

  describe('carts', () => {
    it('a guest cart: items, tiers, bundles, stock limits', async () => {
      const created = await store('post', '/cart').expect(200);
      expect(created.headers['cache-control']).toBe('private, no-store');
      id.guestCart = created.body.token;
      expect(created.body).toMatchObject({
        currency: 'USD',
        items: [],
        missing: ['items', 'email'],
      });
      const cart = (
        path: string,
        method: 'post' | 'put' | 'patch' | 'delete' = 'post',
        body?: object,
      ) => store(method, `/cart${path}`, { cart: id.guestCart, body });

      let c = (
        await cart('/items', 'post', { sku: 'TEE', quantity: 2 }).expect(200)
      ).body;
      expect(c.items[0]).toMatchObject({
        sku: 'TEE',
        quantity: 2,
        unitPrice: { amount: 2500 },
        rowTotal: { amount: 5000 },
      });
      c = (
        await cart('/items', 'post', { sku: 'TEE', quantity: 3 }).expect(200)
      ).body;
      // 5 tees reach the quantity tier.
      expect(c.items).toHaveLength(1);
      expect(c.items[0]).toMatchObject({
        quantity: 5,
        unitPrice: { amount: 2000 },
      });
      await cart('/items', 'post', { sku: 'TEE', quantity: 6 }).expect(409);
      await cart('/items', 'post', { sku: 'NOPE', quantity: 1 }).expect(404);
      await cart('/items', 'post', {
        sku: 'MUG',
        quantity: 1,
        options: [{ option: 'x', sku: 'y' }],
      }).expect(400);
      c = (
        await cart('/items', 'post', {
          sku: 'KIT',
          quantity: 1,
          options: [{ option: 'mug', sku: 'MUG', quantity: 1 }],
        }).expect(200)
      ).body;
      const kit = c.items.find((i: Body) => i.sku === 'KIT');
      expect(kit).toMatchObject({
        unitPrice: { amount: 2500 + 1000 },
        options: expect.arrayContaining([
          { option: 'shirt', sku: 'TEE', quantity: 1 },
        ]),
      });
      // The kit's tee counts against tee stock: 5 + 1 of 10.
      c = (await cart(`/items/${kit.id}`, 'delete').expect(200)).body;
      const teeLine = c.items[0];
      c = (
        await cart(`/items/${teeLine.id}`, 'patch', { quantity: 2 }).expect(200)
      ).body;
      expect(c.totals).toMatchObject({
        subtotal: { amount: 5000, formatted: '$50.00' },
        pricesIncludeTax: false,
      });
      await store('get', '/cart').expect(404);
      await store('get', '/cart', {
        cart: 'not-a-real-token-1234567890',
      }).expect(404);
    });

    it('addresses, shipping, tax and the remaining checkout steps', async () => {
      const cart = (
        path: string,
        method: 'post' | 'put' | 'get' = 'put',
        body?: object,
      ) => store(method, `/cart${path}`, { cart: id.guestCart, body });
      await cart('/addresses', 'put', {
        shipping: { firstName: 'Ann' },
      }).expect(400);
      let c = (
        await cart('/addresses', 'put', { shipping: address }).expect(200)
      ).body;
      expect(c.missing).toEqual(['email', 'shippingMethod']);
      const methods = (await cart('/shipping-methods', 'get').expect(200)).body;
      expect(methods.map((m: Body) => [m.code, m.price.amount])).toEqual([
        ['standard', 799],
        ['express', 1000],
      ]);
      await cart('/shipping-method', 'put', { code: 'overnight' }).expect(400);
      c = (
        await cart('/shipping-method', 'put', { code: 'standard' }).expect(200)
      ).body;
      c = (
        await cart('/email', 'put', { email: 'Guest@Example.com' }).expect(200)
      ).body;
      // 2 tees $50 + shipping $7.99 (taxable), CA 7.25%: tax = 3.63 + 0.58.
      expect(c).toMatchObject({
        email: 'guest@example.com',
        missing: [],
        shippingMethod: { code: 'standard', price: { amount: 799 } },
        totals: {
          subtotal: { amount: 5000 },
          shipping: { amount: 799 },
          tax: { amount: 421 },
          grandTotal: { amount: 6220 },
          amountDue: { amount: 6220 },
        },
      });
      expect(c.items[0].tax.amount).toBe(363);
    });
  });

  // ── Helpers for the order flows ──

  /** A cart ready to check out: items, address, shipping (when physical) and e-mail. */
  async function readyCart(opts: {
    code?: string;
    bearer?: string;
    items: { sku: string; quantity: number }[];
    address?: object;
    shipping?: string;
    email?: string;
  }): Promise<string | undefined> {
    const code = opts.code ?? 'us-en';
    const cart = opts.bearer
      ? undefined
      : (await store('post', '/cart', { code }).expect(200)).body.token;
    const call = (method: 'post' | 'put', path: string, body: object) =>
      store(method, `/cart${path}`, { code, cart, bearer: opts.bearer, body });
    for (const i of opts.items) await call('post', '/items', i).expect(200);
    await call('put', '/addresses', {
      shipping: opts.address ?? address,
    }).expect(200);
    if (opts.shipping)
      await call('put', '/shipping-method', { code: opts.shipping }).expect(
        200,
      );
    if (!opts.bearer)
      await call('put', '/email', {
        email: opts.email ?? 'guest@example.com',
      }).expect(200);
    return cart;
  }

  const place = (
    key: string,
    opts: { code?: string; cart?: string; bearer?: string },
  ) =>
    store('post', '/orders', { ...opts, headers: { 'idempotency-key': key } });

  const pay = (
    number: string,
    method: string,
    opts: { code?: string; order?: string; bearer?: string },
  ) =>
    store('post', `/orders/${number}/payments`, {
      code: opts.code,
      bearer: opts.bearer,
      headers: opts.order ? { 'x-order-token': opts.order } : {},
      body: { method, returnUrl: 'https://shop.example/checkout/return' },
    });

  const getOrder = (
    number: string,
    opts: { code?: string; order?: string; bearer?: string },
  ) =>
    store('get', `/orders/${number}`, {
      code: opts.code,
      bearer: opts.bearer,
      headers: opts.order ? { 'x-order-token': opts.order } : {},
    });

  describe('card (Stripe): order → webhook → invoice → shipment → refunds', () => {
    it('places the order once per Idempotency-Key and keeps checkout honest', async () => {
      await place('short', { cart: id.guestCart }).expect(400);
      const first = await place('checkout-guest-0001', {
        cart: id.guestCart,
      }).expect(200);
      const again = await place('checkout-guest-0001', {
        cart: id.guestCart,
      }).expect(200);
      expect(again.body.number).toBe(first.body.number);
      expect(first.body).toMatchObject({
        status: 'PENDING_PAYMENT',
        paymentStatus: 'UNPAID',
        email: 'guest@example.com',
        totals: {
          grandTotal: { amount: 6220 },
          amountDue: { amount: 6220 },
          tax: { amount: 421 },
        },
        shippingMethod: 'Standard',
      });
      expect(first.body.accessToken).toEqual(again.body.accessToken);
      id.order1 = first.body.number;
      id.order1Token = first.body.accessToken;
      // The cart became the order.
      await eventually(
        () => store('get', '/cart', { cart: id.guestCart }),
        (r) => r.status === 404,
      );
      // Someone else can't read it; the guest token can.
      await getOrder(id.order1, {}).expect(404);
      await getOrder(id.order1, {
        order: 'wrong-token-wrong-token-wrong',
      }).expect(404);
      await getOrder(id.order1, { order: id.order1Token }).expect(200);
    });

    it('pays by card: client secret, a signed webhook (once), invoice', async () => {
      const methods = await store(
        'get',
        `/orders/${id.order1}/payment-methods`,
        {
          headers: { 'x-order-token': id.order1Token },
        },
      ).expect(200);
      expect(methods.body.map((m: Body) => m.code)).toEqual([
        'card',
        'paypal',
        'cod',
      ]);
      const p = await pay(id.order1, 'card', { order: id.order1Token }).expect(
        200,
      );
      expect(p.body).toMatchObject({
        status: 'PENDING',
        provider: 'STRIPE',
        amount: { amount: 6220 },
        action: { type: 'CLIENT_SECRET', publishableKey: 'pk_test_emulator' },
      });
      // Asking again shows the same attempt.
      const same = await pay(id.order1, 'card', {
        order: id.order1Token,
      }).expect(200);
      expect(same.body.id).toBe(p.body.id);
      const intent = [...emulator.stripeIntents.values()].find(
        (i) => i.metadata.payment_id === p.body.id,
      )!;
      expect(intent).toMatchObject({ amount: 6220, currency: 'usd' });

      const hook = emulator.stripeSucceed(intent.id);
      const url = `/api/v1/webhooks/payments/${id.stripe}`;
      await http()
        .post(url)
        .set({ ...hook.headers, 'stripe-signature': 't=1,v1=forged' })
        .send(hook.body)
        .expect(400);
      await http().post(url).set(hook.headers).send(hook.body).expect(200);
      await http().post(url).set(hook.headers).send(hook.body).expect(200); // duplicate: once
      const paid = await eventually(
        () => getOrder(id.order1, { order: id.order1Token }),
        (r) => r.body.paymentStatus === 'PAID',
      );
      expect(paid.body).toMatchObject({
        status: 'PROCESSING',
        totals: { amountPaid: { amount: 6220 } },
        invoices: [
          {
            number: expect.stringMatching(/^INV-US-\d{4}-000001$/),
            amount: { amount: 6220 },
          },
        ],
      });
      const admin1 = (
        await admin('get', `/orders?search=${id.order1}`).expect(200)
      ).body.data[0];
      id.order1Id = admin1.id;
      const trail = (
        await admin('get', `/orders/${id.order1Id}/payments`).expect(200)
      ).body;
      expect(
        trail.payments[0].transactions.map(
          (t: Body) => `${t.type}:${t.source}`,
        ),
      ).toEqual(['INITIATE:api', 'CAPTURE:webhook']);
      const hooks = (await admin('get', '/payment-webhooks').expect(200)).body;
      expect(hooks.total).toBe(1);
    });

    it('ships, then refunds one returned tee (restocked) and the rest', async () => {
      const shipped = await admin('post', `/orders/${id.order1Id}/shipments`, {
        carrier: 'ups',
        trackingNumber: '1Z999',
      }).expect(201);
      expect(shipped.body.number).toMatch(/^SH-US-\d{6}$/);
      let o = (await admin('get', `/orders/${id.order1Id}`).expect(200)).body;
      expect(o).toMatchObject({
        status: 'COMPLETE',
        fulfillmentStatus: 'FULFILLED',
      });
      await admin('post', `/orders/${id.order1Id}/shipments`, {
        carrier: 'ups',
      }).expect(409);

      const tee = o.items[0];
      const r1 = await http()
        .post(`/api/v1/admin/orders/${id.order1Id}/refunds`)
        .auth(token, { type: 'bearer' })
        .set('idempotency-key', 'refund-one-tee')
        .send({
          items: [{ orderItemId: tee.id, quantity: 1 }],
          restock: true,
          reason: 'Wrong size',
        })
        .expect(200);
      // One tee: $25.00 + its tax $1.81 (half of 3.63, rounded down).
      expect(r1.body).toMatchObject({
        status: 'SUCCEEDED',
        amount: { amount: 2681 },
        restock: true,
      });
      const again = await http()
        .post(`/api/v1/admin/orders/${id.order1Id}/refunds`)
        .auth(token, { type: 'bearer' })
        .set('idempotency-key', 'refund-one-tee')
        .send({ items: [{ orderItemId: tee.id, quantity: 1 }], restock: true })
        .expect(200);
      expect(again.body.id).toBe(r1.body.id);
      o = (
        await eventually(
          () => admin('get', `/orders/${id.order1Id}`),
          (r) => r.body.paymentStatus === 'PARTIALLY_REFUNDED',
        )
      ).body;
      expect(o.items[0].qtyRefunded).toBe(1);
      expect(o.creditMemos).toEqual([
        expect.objectContaining({
          amount: { amount: 2681, formatted: '$26.81' },
        }),
      ]);
      await admin('post', `/orders/${id.order1Id}/refunds`, {
        amount: 999_999,
      }).expect(400);
      const rest = await admin('post', `/orders/${id.order1Id}/refunds`, {
        reason: 'Goodwill',
      }).expect(200);
      expect(rest.body.amount.amount).toBe(6220 - 2681);
      o = (
        await eventually(
          () => admin('get', `/orders/${id.order1Id}`),
          (r) => r.body.status === 'CLOSED',
        )
      ).body;
      expect(o).toMatchObject({
        paymentStatus: 'REFUNDED',
        totals: { amountRefunded: { amount: 6220 } },
      });
      expect(
        emulator.refunds
          .filter((r) => r.provider === 'stripe')
          .map((r) => r.amount),
      ).toEqual(['2681', '3539']);
      // The returned tee is back on the shelf: 10 − 2 sold + 1 returned.
      const movements = (
        await admin(
          'get',
          `/inventory/movements?variantId=${id.teeVariant}&limit=100`,
        ).expect(200)
      ).body.data as Body[];
      expect(
        movements.some((m) => m.reason === 'RETURN' && m.delta === 1),
      ).toBe(true);
      expect(movements.some((m) => m.reason === 'SALE' && m.delta === -2)).toBe(
        true,
      );
    });
  });

  describe('PayPal for a signed-in customer, with points', () => {
    it('approve on PayPal → capture on return → points earned; a full refund takes them back', async () => {
      await admin('put', `/loyalty/programs/${id.us}`, {
        name: 'Rewards',
        currencyCode: 'USD',
        spendPerPoint: 100,
        pointValue: 1,
      }).expect(200);
      const reg = await store('post', '/account/register', {
        body: {
          email: 'ann@example.com',
          password: PASSWORD,
          firstName: 'Ann',
          lastName: 'Lee',
        },
      }).expect(200);
      id.ann = reg.body.accessToken;
      // A guest cart merges into the customer's cart when they sign in.
      const guest = (await store('post', '/cart').expect(200)).body.token;
      await store('post', '/cart/items', {
        cart: guest,
        body: { sku: 'MUG', quantity: 1 },
      }).expect(200);
      await store('post', '/cart/items', {
        bearer: id.ann,
        body: { sku: 'EBOOK', quantity: 1 },
      }).expect(200);
      const merged = await store('post', '/cart/merge', {
        bearer: id.ann,
        body: { token: guest },
      }).expect(200);
      expect(merged.body.items.map((i: Body) => i.sku).sort()).toEqual([
        'EBOOK',
        'MUG',
      ]);
      await readyCart({ bearer: id.ann, items: [], shipping: 'express' });
      const placed = await place('checkout-ann-00001', {
        bearer: id.ann,
      }).expect(200);
      expect(placed.body.accessToken).toBeUndefined();
      id.order2 = placed.body.number;
      // MUG $10 + EBOOK $9 + express $5 (not taxed) + CA tax on goods 7.25%: 0.73 + 0.65.
      expect(placed.body.totals.grandTotal.amount).toBe(
        1000 + 900 + 500 + 73 + 65,
      );

      const p = await pay(id.order2, 'paypal', { bearer: id.ann }).expect(200);
      expect(p.body.action).toMatchObject({
        type: 'REDIRECT',
        url: expect.stringContaining('sandbox.paypal.com'),
      });
      const ppOrder = new URL(p.body.action.url).searchParams.get('token')!;
      // Returning before approving: capture refused, still pending.
      const early = await store(
        'post',
        `/orders/${id.order2}/payments/${p.body.id}/return`,
        {
          bearer: id.ann,
          body: { params: { token: ppOrder } },
        },
      ).expect(200);
      expect(early.body.status).toBe('FAILED');
      // Try again: a new attempt, approved this time.
      const p2 = await pay(id.order2, 'paypal', { bearer: id.ann }).expect(200);
      const ppOrder2 = new URL(p2.body.action.url).searchParams.get('token')!;
      const done = await store(
        'post',
        `/orders/${id.order2}/payments/${p2.body.id}/return`,
        {
          bearer: id.ann,
          body: { params: emulator.paypalApprove(ppOrder2) },
        },
      ).expect(200);
      expect(done.body.status).toBe('CAPTURED');
      const o = await eventually(
        () => getOrder(id.order2, { bearer: id.ann }),
        (r) => r.body.paymentStatus === 'PAID',
      );
      expect(o.body.status).toBe('PROCESSING');
      const points = await eventually(
        () => store('get', '/account/loyalty', { bearer: id.ann }),
        (r) => r.body?.balance > 0,
      );
      expect(points.body.balance).toBe(19); // $19 of goods, 1 point per $1
      const list = await store('get', '/orders', { bearer: id.ann }).expect(
        200,
      );
      expect(list.body.data.map((x: Body) => x.number)).toEqual([id.order2]);

      const orderId = (
        await admin('get', `/orders?search=${id.order2}`).expect(200)
      ).body.data[0].id;
      // PayPal answers the refund as pending: nothing changes until it completes.
      emulator.paypalRefundsPending = true;
      const pending = await admin('post', `/orders/${orderId}/refunds`, {
        reason: 'Cancelled after payment',
      }).expect(200);
      emulator.paypalRefundsPending = false;
      expect(pending.body.status).toBe('PENDING');
      // Nothing more can be refunded while it is pending.
      await admin('post', `/orders/${orderId}/refunds`, { amount: 1 }).expect(
        409,
      );
      const before = await admin('get', `/orders/${orderId}`).expect(200);
      expect(before.body.paymentStatus).toBe('PAID');
      expect(before.body.creditMemos).toEqual([]);
      // Completed at PayPal; reconciliation records it (the job, or "check now").
      emulator.completePaypalRefunds();
      const rec = await admin('post', '/payments/reconcile').expect(200);
      expect(rec.body.refunds).toEqual({ checked: 1, settled: 1 });
      const refunded = await eventually(
        () => admin('get', `/orders/${orderId}`),
        (r) => r.body.paymentStatus === 'REFUNDED',
      );
      expect(refunded.body.status).toBe('CLOSED');
      expect(refunded.body.creditMemos).toHaveLength(1);
      await eventually(
        () => store('get', '/account/loyalty', { bearer: id.ann }),
        (r) => r.body?.balance === 0,
      );
      // Settled once: asking again changes nothing.
      expect(
        (await admin('post', '/payments/reconcile').expect(200)).body.refunds,
      ).toEqual({ checked: 0, settled: 0 });
      expect(
        emulator.refunds.some(
          (r) => r.provider === 'paypal' && r.amount === '25.38',
        ),
      ).toBe(true);
    });
  });

  describe('Vietnam: VNPay and MoMo (VND, tax-inclusive)', () => {
    it('VNPay: signed redirect → signed IPN → shipment → refund through the merchant API', async () => {
      const cart = await readyCart({
        code: 'vn-vi',
        items: [{ sku: 'TEE', quantity: 2 }],
        address: {
          ...address,
          countryCode: 'VN',
          regionCode: undefined,
          city: 'Hà Nội',
          postcode: '100000',
        },
        shipping: 'standard',
      });
      const placed = await place('checkout-vnpay-001', {
        code: 'vn-vi',
        cart,
      }).expect(200);
      expect(placed.body.totals).toMatchObject({
        pricesIncludeTax: true,
        subtotal: { amount: 550_000 },
        shipping: { amount: 30_000 },
        grandTotal: { amount: 580_000 },
        tax: { amount: 50_000 },
      });
      const t = placed.body.accessToken;
      const methods = await store(
        'get',
        `/orders/${placed.body.number}/payment-methods`,
        {
          code: 'vn-vi',
          headers: { 'x-order-token': t },
        },
      ).expect(200);
      expect(methods.body.map((m: Body) => m.code)).toEqual(['vnpay', 'momo']);
      const p = await pay(placed.body.number, 'vnpay', {
        code: 'vn-vi',
        order: t,
      }).expect(200);
      expect(p.body.action.url).toContain('vnp_Amount=58000000');
      const ipn = emulator.vnpayResult(p.body.action.url);
      const hookUrl = `/api/v1/webhooks/payments/${id.vnpay}`;
      const bad = await http()
        .get(hookUrl)
        .query({ ...ipn, vnp_Amount: '1' })
        .expect(200);
      expect(bad.body.RspCode).toBe('97');
      const ok = await http().get(hookUrl).query(ipn).expect(200);
      expect(ok.body).toEqual({ RspCode: '00', Message: 'Confirm Success' });
      const dup = await http().get(hookUrl).query(ipn).expect(200);
      expect(dup.body.RspCode).toBe('02');
      await eventually(
        () => getOrder(placed.body.number, { code: 'vn-vi', order: t }),
        (r) => r.body.paymentStatus === 'PAID',
      );
      const orderId = (
        await admin('get', `/orders?search=${placed.body.number}`).expect(200)
      ).body.data[0].id;
      await admin('post', `/orders/${orderId}/shipments`, {
        carrier: 'ghn',
      }).expect(201);
      const r = await admin('post', `/orders/${orderId}/refunds`, {
        amount: 100_000,
        reason: 'Hoàn tiền một phần',
      }).expect(200);
      expect(r.body.status).toBe('SUCCEEDED');
      expect(emulator.vnpayRefunds[0]).toMatchObject({
        vnp_TransactionType: '03',
        vnp_Amount: '10000000',
      });
    });

    it('MoMo: wallet redirect → signed IPN (204) → refund', async () => {
      const cart = await readyCart({
        code: 'vn-vi',
        items: [{ sku: 'MUG', quantity: 1 }],
        address: {
          ...address,
          countryCode: 'VN',
          regionCode: undefined,
          city: 'Huế',
          postcode: '530000',
        },
        shipping: 'standard',
      });
      const placed = await place('checkout-momo-0001', {
        code: 'vn-vi',
        cart,
      }).expect(200);
      const t = placed.body.accessToken;
      const p = await pay(placed.body.number, 'momo', {
        code: 'vn-vi',
        order: t,
      }).expect(200);
      expect(p.body.action).toMatchObject({
        type: 'REDIRECT',
        deeplink: 'momo://pay',
      });
      // Not paid yet: reconciliation asks MoMo and leaves it pending.
      const svc = (await import('../src/modules/payments/payments.service.js'))
        .PaymentsService;
      const rec = await app
        .get(svc)
        .reconcile(new Date(Date.now() + 10 * 60_000));
      expect(rec.checked).toBeGreaterThanOrEqual(1);
      const ipn = emulator.momoIpn(p.body.id);
      await http()
        .post(`/api/v1/webhooks/payments/${id.momo}`)
        .set('content-type', 'application/json')
        .send(JSON.stringify({ ...ipn, signature: 'f'.repeat(64) }))
        .expect(400);
      await http()
        .post(`/api/v1/webhooks/payments/${id.momo}`)
        .set('content-type', 'application/json')
        .send(JSON.stringify(ipn))
        .expect(204);
      await eventually(
        () => getOrder(placed.body.number, { code: 'vn-vi', order: t }),
        (r) => r.body.paymentStatus === 'PAID',
      );
      const orderId = (
        await admin('get', `/orders?search=${placed.body.number}`).expect(200)
      ).body.data[0].id;
      await admin('post', `/orders/${orderId}/refunds`, {}).expect(200);
      expect(
        emulator.refunds.some(
          (r) => r.provider === 'momo' && r.amount === String(140_000),
        ),
      ).toBe(true);
    });
  });

  describe('cash on delivery, cancellations and late payments', () => {
    it('COD: accepted at once, stock sold, shipped, then collected → complete', async () => {
      const cart = await readyCart({
        items: [{ sku: 'MUG', quantity: 2 }],
        shipping: 'standard',
      });
      const placed = await place('checkout-cod-00001', { cart }).expect(200);
      const t = placed.body.accessToken;
      const p = await pay(placed.body.number, 'cod', { order: t }).expect(200);
      expect(p.body).toMatchObject({
        status: 'AWAITING_COLLECTION',
        action: null,
      });
      const accepted = await eventually(
        () => getOrder(placed.body.number, { order: t }),
        (r) => r.body.status === 'PROCESSING',
      );
      expect(accepted.body.paymentStatus).toBe('UNPAID');
      const orderId = (
        await admin('get', `/orders?search=${placed.body.number}`).expect(200)
      ).body.data[0].id;
      await admin('post', `/orders/${orderId}/shipments`, {
        carrier: 'ups',
      }).expect(201);
      expect(
        (await admin('get', `/orders/${orderId}`).expect(200)).body.status,
      ).toBe('PROCESSING');
      await admin('post', `/payments/${p.body.id}/capture`).expect(200);
      const o = await eventually(
        () => admin('get', `/orders/${orderId}`),
        (r) => r.body.status === 'COMPLETE',
      );
      expect(o.body.paymentStatus).toBe('PAID');
      await admin('post', `/payments/${p.body.id}/capture`).expect(409);
    });

    it('an unpaid order can be cancelled: stock and promotion uses come back', async () => {
      const promo = (
        await admin('post', '/marketing/promotions', {
          name: 'Mug deal',
          websiteIds: [id.us],
          requiresCoupon: true,
          usageLimit: 1,
          conditions: [],
          actions: [
            {
              type: 'percent_off_items',
              percent: 10,
              filter: { skus: ['MUG'] },
            },
          ],
        }).expect(201)
      ).body.id;
      await admin('post', `/marketing/promotions/${promo}/coupons`, {
        code: 'MUG10',
      }).expect(201);
      await admin('post', `/marketing/promotions/${promo}/publish`, {}).expect(
        200,
      );
      const cart = await readyCart({
        items: [{ sku: 'MUG', quantity: 1 }],
        shipping: 'standard',
      });
      await store('put', '/cart/coupon', {
        cart,
        body: { code: 'MUG10' },
      }).expect(200);
      const placed = await place('checkout-cancel-01', { cart }).expect(200);
      expect(placed.body.promotions).toEqual([
        expect.objectContaining({
          discount: { amount: 100, formatted: '$1.00' },
        }),
      ]);
      // The coupon's single use is taken.
      const other = await readyCart({
        items: [{ sku: 'MUG', quantity: 1 }],
        shipping: 'standard',
      });
      await store('put', '/cart/coupon', {
        cart: other,
        body: { code: 'MUG10' },
      }).expect(400);
      const canceled = await store(
        'post',
        `/orders/${placed.body.number}/cancel`,
        {
          headers: { 'x-order-token': placed.body.accessToken },
          body: { reason: 'Changed my mind' },
        },
      ).expect(200);
      expect(canceled.body.status).toBe('CANCELED');
      await eventually(
        () =>
          store('put', '/cart/coupon', {
            cart: other,
            body: { code: 'MUG10' },
          }),
        (r) => r.status === 200,
      );
      await pay(placed.body.number, 'card', {
        order: placed.body.accessToken,
      }).expect(409);
    });

    it('unpaid orders expire; a payment arriving after cancellation is refunded automatically', async () => {
      const cart = await readyCart({
        items: [{ sku: 'MUG', quantity: 1 }],
        shipping: 'standard',
      });
      const placed = await place('checkout-late-0001', { cart }).expect(200);
      const t = placed.body.accessToken;
      const p = await pay(placed.body.number, 'card', { order: t }).expect(200);
      const n = await app
        .get(OrdersService)
        .expireUnpaid(new Date(Date.now() + 2 * 3_600_000));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(
        (await getOrder(placed.body.number, { order: t })).body.status,
      ).toBe('CANCELED');
      // The shopper had already confirmed the card: Stripe tells us after the cancellation.
      const intent = [...emulator.stripeIntents.values()].find(
        (i) => i.metadata.payment_id === p.body.id,
      )!;
      expect(intent.status).toBe('canceled'); // we cancelled the intent at Stripe…
      intent.status = 'requires_payment_method'; // …but pretend the confirmation raced it
      const hook = emulator.stripeSucceed(intent.id);
      await http()
        .post(`/api/v1/webhooks/payments/${id.stripe}`)
        .set(hook.headers)
        .send(hook.body)
        .expect(200);
      const orderId = (
        await admin('get', `/orders?search=${placed.body.number}`).expect(200)
      ).body.data[0].id;
      const trail = await eventually(
        () => admin('get', `/orders/${orderId}/payments`),
        (r) => r.body.refunds?.length === 1,
      );
      expect(trail.body.refunds[0]).toMatchObject({
        status: 'SUCCEEDED',
        reason: expect.stringContaining('cancelled'),
      });
    });

    it('no provider ever saw a wrong key or signature', () => {
      expect(emulator.rejected).toEqual([]);
    });
  });

  describe('admin order filters', () => {
    it('filters orders by payment and fulfilment status and by date', async () => {
      const all = (await admin('get', '/orders?limit=100').expect(200)).body;
      const paid = (
        await admin('get', '/orders?limit=100&paymentStatus=PAID').expect(200)
      ).body;
      expect(paid.data.length).toBeGreaterThan(0);
      expect(
        paid.data.every(
          (o: { paymentStatus: string }) => o.paymentStatus === 'PAID',
        ),
      ).toBe(true);
      const unfulfilled = (
        await admin(
          'get',
          '/orders?limit=100&fulfillmentStatus=UNFULFILLED',
        ).expect(200)
      ).body;
      expect(
        unfulfilled.data.every(
          (o: { fulfillmentStatus: string }) =>
            o.fulfillmentStatus === 'UNFULFILLED',
        ),
      ).toBe(true);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      expect(
        (await admin('get', `/orders?placedFrom=${tomorrow}`).expect(200)).body
          .total,
      ).toBe(0);
      expect(
        (
          await admin('get', `/orders?placedTo=${tomorrow}&limit=100`).expect(
            200,
          )
        ).body.total,
      ).toBe(all.total);
      await admin('get', '/orders?placedFrom=yesterday').expect(400);
    });
  });

  describe('reports', () => {
    it('the dashboard overview sums sales per currency, never across them', async () => {
      const all = await admin('get', '/reports/overview?days=7').expect(200);
      expect(all.body.currencies).toEqual(
        expect.arrayContaining(['USD', 'VND']),
      );
      expect(all.body.daily).toHaveLength(7);
      expect(all.body.byStatus.length).toBeGreaterThan(0);

      const usd = await admin(
        'get',
        '/reports/overview?days=7&currency=USD',
      ).expect(200);
      const { current } = usd.body;
      expect(usd.body.currency).toBe('USD');
      expect(current.orders).toBeGreaterThan(0);
      expect(current.revenue.formatted).toMatch(/^\$/);
      expect(
        usd.body.daily.reduce(
          (s: number, d: { revenue: number }) => s + d.revenue,
          0,
        ),
      ).toBe(current.revenue.amount);
      expect(current.averageOrderValue.amount).toBe(
        Math.floor(current.revenue.amount / current.orders),
      );
      expect(usd.body.topProducts[0]).toMatchObject({
        sku: expect.any(String),
        quantity: expect.any(Number),
      });
      expect(usd.body.previous.orders).toBe(0);

      await admin('get', '/reports/overview?days=0').expect(400);
      await admin('get', '/reports/overview?currency=usd').expect(400);
    });
  });
});
