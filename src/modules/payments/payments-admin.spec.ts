import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { fakeStores } from '../../testing/stores.js';
import {
  CheckoutJobsProcessor,
  CheckoutJobsScheduler,
} from './checkout-jobs.processor.js';
import { eligible, PaymentConfigService } from './payment-config.service.js';
import {
  CartPaymentMethodsController,
  PaymentsAdminController,
  PaymentWebhooksController,
  StorefrontPaymentsController,
} from './payments.controllers.js';
import { PaymentsListener } from './payments.listener.js';
import { RefundsService, sanitize } from './refunds.service.js';

const STRIPE = { secretKey: 'sk', publishableKey: 'pk', webhookSecret: 'wh' };

describe('eligible', () => {
  const m = {
    currencyCodes: ['USD'],
    countryCodes: ['US'],
    minAmounts: { USD: 100 },
    maxAmounts: { USD: 1000 },
  };
  const input = { currencyCode: 'USD', countryCode: 'US', amount: 500n };
  it('checks currency, billing country and amount limits', () => {
    expect(eligible(m, input)).toBe(true);
    expect(eligible(m, { ...input, currencyCode: 'VND' })).toBe(false);
    expect(eligible(m, { ...input, countryCode: 'VN' })).toBe(false);
    expect(eligible(m, { ...input, countryCode: null })).toBe(true);
    expect(eligible(m, { ...input, amount: 99n })).toBe(false);
    expect(eligible(m, { ...input, amount: 1001n })).toBe(false);
    expect(
      eligible(
        {
          currencyCodes: [],
          countryCodes: [],
          minAmounts: null,
          maxAmounts: null,
        },
        { ...input, currencyCode: 'VND' },
      ),
    ).toBe(true);
  });
});

describe('PaymentConfigService', () => {
  function setup() {
    const prisma = fakePrisma();
    const b = fakeBus(prisma);
    const secrets = {
      seal: vi.fn<AnyFn>(() => 'sealed'),
      open: vi.fn<AnyFn>(() => ({ ...STRIPE, apiBase: 'http://emulator' })),
    };
    const config = { get: vi.fn<AnyFn>(() => 'https://api.shop.example') };
    return {
      prisma,
      b,
      secrets,
      svc: new PaymentConfigService(
        prisma as never,
        b.bus,
        secrets as never,
        config as never,
      ),
    };
  }
  const row = {
    id: 'p1',
    code: 'STRIPE',
    name: 'Stripe',
    mode: 'TEST',
    isActive: true,
    credentials: 'sealed',
  };

  it('creates providers with sealed, validated credentials', async () => {
    const { svc, prisma, secrets, b } = setup();
    prisma.paymentProvider.create.mockResolvedValue(row);
    const p = await svc.createProvider(
      { code: 'STRIPE', name: 'Stripe', credentials: STRIPE },
      ROOT,
    );
    expect(p).toMatchObject({
      configured: true,
      webhookUrl: 'https://api.shop.example/api/v1/webhooks/payments/p1',
    });
    expect(secrets.seal).toHaveBeenCalledWith(STRIPE);
    expect(b.afterNames()).toEqual(['payment-provider.created']);
    prisma.paymentProvider.create.mockResolvedValue({
      ...row,
      code: 'COD',
      credentials: null,
    });
    expect(
      (await svc.createProvider({ code: 'COD', name: 'Cash' }, ROOT))
        .configured,
    ).toBe(true);
    await expect(
      svc.createProvider({ code: 'STRIPE', name: 'S' }, ROOT),
    ).rejects.toThrow('needs credentials');
    await expect(
      svc.createProvider(
        {
          code: 'STRIPE',
          name: 'S',
          mode: 'LIVE',
          credentials: { ...STRIPE, apiBase: 'http://x' },
        },
        ROOT,
      ),
    ).rejects.toThrow('apiBase must be https');
    prisma.paymentProvider.findMany.mockResolvedValue([row]);
    expect(await svc.providers()).toHaveLength(1);
  });

  it('updates providers; going live re-checks stored endpoint overrides', async () => {
    const { svc, prisma, secrets, b } = setup();
    prisma.paymentProvider.findUnique.mockResolvedValue(row);
    prisma.paymentProvider.update.mockResolvedValue(row);
    await svc.updateProvider(
      'p1',
      { name: 'S2', isActive: false, credentials: STRIPE },
      ROOT,
    );
    expect(
      (b.after[0] as unknown as { audit: { changes: object } }).audit.changes,
    ).toEqual({ name: 'S2', isActive: false, credentials: 'replaced' });
    await expect(
      svc.updateProvider('p1', { mode: 'LIVE' }, ROOT),
    ).rejects.toThrow('apiBase must be https in LIVE mode');
    secrets.open.mockReturnValueOnce(STRIPE as never);
    await svc.updateProvider('p1', { mode: 'LIVE' }, ROOT);
    expect(
      prisma.paymentProvider.update.mock.calls.at(-1)![0].data,
    ).toMatchObject({ mode: 'LIVE', credentials: undefined });
    prisma.paymentProvider.findUnique.mockResolvedValue(null);
    await expect(svc.updateProvider('p1', {}, ROOT)).rejects.toThrow(
      'not found',
    );
    await expect(svc.removeProvider('p1', ROOT)).rejects.toThrow('not found');
    prisma.paymentProvider.findUnique.mockResolvedValue({ code: 'STRIPE' });
    await svc.removeProvider('p1', ROOT);
    expect(b.afterNames().at(-1)).toBe('payment-provider.deleted');
  });

  const method = {
    id: 'm1',
    storeId: 's1',
    providerId: 'p1',
    code: 'card',
    position: 0,
    minAmounts: null,
    maxAmounts: { USD: 100000 },
    countryCodes: [],
    currencyCodes: ['USD'],
    isActive: true,
    translations: [{ localeCode: 'en-US', title: 'Card', description: null }],
  };

  it('manages store methods', async () => {
    const { svc, prisma, b } = setup();
    prisma.storePaymentMethod.findMany.mockResolvedValue([method]);
    expect((await svc.methods('s1'))[0]).toMatchObject({
      minAmounts: null,
      titles: [{ title: 'Card', description: undefined }],
    });
    prisma.storePaymentMethod.create.mockResolvedValue(method);
    await svc.createMethod(
      {
        storeId: 's1',
        providerId: 'p1',
        code: 'card',
        maxAmounts: { USD: 100000 },
        minAmounts: { USD: 1 },
        titles: [{ localeCode: 'en-US', title: 'Card' }],
      },
      ROOT,
    );
    expect(
      prisma.storePaymentMethod.create.mock.calls[0][0].data,
    ).toMatchObject({ position: 0, countryCodes: [], isActive: true });
    await expect(
      svc.createMethod(
        {
          storeId: 's1',
          providerId: 'p1',
          code: 'x',
          maxAmounts: { usd: 1 },
          titles: [],
        } as never,
        ROOT,
      ),
    ).rejects.toThrow('maxAmounts');
    prisma.storePaymentMethod.findUnique.mockResolvedValue({ id: 'm1' });
    prisma.storePaymentMethod.update.mockResolvedValue(method);
    await svc.updateMethod(
      'm1',
      {
        titles: [{ localeCode: 'en-US', title: 'Cards' }],
        minAmounts: null,
        maxAmounts: { USD: 5 },
      },
      ROOT,
    );
    expect(prisma.storePaymentMethodTranslation.createMany).toHaveBeenCalled();
    await svc.updateMethod('m1', { position: 2 }, ROOT);
    await expect(
      svc.updateMethod('m1', { minAmounts: { USD: -1 } }, ROOT),
    ).rejects.toThrow('minAmounts');
    await svc.removeMethod('m1', ROOT);
    expect(b.afterNames()).toEqual([
      'payment-method.created',
      'payment-method.updated',
      'payment-method.updated',
      'payment-method.deleted',
    ]);
    prisma.storePaymentMethod.findUnique.mockResolvedValue(null);
    await expect(svc.updateMethod('m1', {}, ROOT)).rejects.toThrow('not found');
    await expect(svc.removeMethod('m1', ROOT)).rejects.toThrow('not found');
  });

  it('offers the eligible methods, translated', async () => {
    const { svc, prisma } = setup();
    prisma.storePaymentMethod.findMany.mockResolvedValue([
      { ...method, provider: { code: 'STRIPE' } },
      {
        ...method,
        id: 'm2',
        code: 'momo',
        currencyCodes: ['VND'],
        provider: { code: 'MOMO' },
      },
      {
        ...method,
        id: 'm3',
        code: 'cod',
        translations: [],
        provider: { code: 'COD' },
      },
    ]);
    const out = await svc.eligibleMethods({
      storeId: 's1',
      currencyCode: 'USD',
      countryCode: 'US',
      amount: 500n,
      localeChain: ['en-US'],
    });
    expect(out.map((m) => [m.code, m.title, m.provider])).toEqual([
      ['card', 'Card', 'STRIPE'],
      ['cod', 'cod', 'COD'],
    ]);
  });
});

describe('RefundsService', () => {
  function setup() {
    const prisma = fakePrisma();
    const b = fakeBus(prisma);
    const orders = {
      paymentFacts: vi.fn<AnyFn>(async () => ({ currencyCode: 'USD' })),
      effects: vi.fn<AnyFn>(async () => ({
        pricesIncludeTax: false,
        items: [
          {
            id: 'i1',
            parentItemId: null,
            sku: 'TEE',
            quantity: 2,
            qtyRefunded: 0,
            rowTotal: 5000n,
            discount: 1000n,
            taxAmount: 400n,
          },
          {
            id: 'i2',
            parentItemId: 'i1',
            sku: 'C',
            quantity: 2,
            qtyRefunded: 0,
            rowTotal: 0n,
            discount: 0n,
            taxAmount: 0n,
          },
        ],
      })),
    };
    const adapter = {
      refund: vi.fn<AnyFn>(async () => ({
        providerRef: 're_1',
        status: 'SUCCEEDED',
        raw: { id: 're_1', secret: 'x' },
      })),
    };
    const adapters = { for: vi.fn<AnyFn>(() => adapter) };
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 10000n } });
    prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.payment.findMany.mockResolvedValue([
      { id: 'pay1', amount: 3000n, refunds: [] },
      { id: 'pay2', amount: 7000n, refunds: [{ amount: 1000n }] },
    ]);
    prisma.refund.create.mockImplementation(async (a: { data: object }) => ({
      id: 'r1',
      ...a.data,
    }));
    // The refund row as the database holds it (updateMany changes it, like a status UPDATE).
    const stored = {
      id: 'r1',
      orderId: 'o1',
      paymentId: 'pay2',
      amount: 4400n,
      status: 'PENDING',
      reason: null as string | null,
      items: [],
      restock: true,
      providerRef: null as string | null,
      failureReason: null as string | null,
    };
    const paymentRow = {
      id: 'pay2',
      providerRef: 'pi',
      captureRef: 'ch',
      amount: 7000n,
      currencyCode: 'USD',
      createdAt: new Date(),
      capturedAt: new Date(),
      provider: { id: 'p', code: 'STRIPE', mode: 'TEST', credentials: 's' },
    };
    prisma.refund.findUniqueOrThrow.mockImplementation(
      async (a: { select: { payment?: unknown } }) =>
        a.select.payment ? { ...stored, payment: paymentRow } : { ...stored },
    );
    prisma.refund.updateMany.mockImplementation(
      async (a: { where: { status: string }; data: object }) => {
        if (stored.status !== a.where.status) return { count: 0 };
        Object.assign(stored, a.data);
        return { count: 1 };
      },
    );
    prisma.payment.findUniqueOrThrow.mockResolvedValue({
      providerCode: 'STRIPE',
      orderId: 'o1',
      amount: 7000n,
      amountRefunded: 0n,
    });
    const svc = new RefundsService(
      prisma as never,
      b.bus,
      orders as never,
      adapters as never,
      fakeStores() as never,
    );
    return { prisma, b, svc, adapter, adapters, orders, stored, paymentRow };
  }

  it('refunds returned items through the payment that covers them', async () => {
    const { svc, prisma, b, adapter } = setup();
    const r = await svc.refund(
      'o1',
      { items: [{ orderItemId: 'i1', quantity: 2 }], restock: true },
      'key-1',
      ROOT,
    );
    expect(prisma.refund.create.mock.calls[0][0].data).toMatchObject({
      paymentId: 'pay2',
      amount: 4400n,
      idempotencyKey: 'key-1',
      createdById: ROOT.id,
      restock: true,
    });
    expect(adapter.refund.mock.calls[0].slice(1)).toEqual([
      4400n,
      'r1',
      'Refund',
    ]);
    expect(r.status).toBe('SUCCEEDED');
    expect(prisma.paymentTransaction.create.mock.calls[0][0].data.raw).toEqual({
      id: 're_1',
      secret: '[redacted]',
    });
    expect(b.afterNames()).toEqual(['payment.refunded']);
    expect((b.after[0] as unknown as { data: object }).data).toMatchObject({
      totalRefunded: '0',
      totalCaptured: '10000',
      restock: true,
    });
  });

  it('is idempotent and never refunds more than was captured', async () => {
    const { svc, prisma } = setup();
    prisma.refund.findUnique.mockResolvedValueOnce({ id: 'old' });
    expect(await svc.refund('o1', {}, 'key-1', ROOT)).toEqual({ id: 'old' });
    await expect(
      svc.refund('o1', { amount: 0 }, undefined, ROOT),
    ).rejects.toThrow('must be positive');
    await expect(
      svc.refund('o1', { amount: 20000 }, undefined, ROOT),
    ).rejects.toThrow('At most 10000');
    await expect(
      svc.refund('o1', { amount: 9000 }, undefined, ROOT),
    ).rejects.toThrow('No single payment');
    await expect(
      svc.refund(
        'o1',
        { items: [{ orderItemId: 'i2', quantity: 1 }] },
        undefined,
        ROOT,
      ),
    ).rejects.toThrow('not a line');
    await expect(
      svc.refund(
        'o1',
        { items: [{ orderItemId: 'i1', quantity: 3 }] },
        undefined,
        ROOT,
      ),
    ).rejects.toThrow('Only 2 of TEE');
    prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 10000n } });
    await expect(svc.refund('o1', {}, undefined, ROOT)).rejects.toThrow(
      'Nothing left',
    );
  });

  it('records pending and failed refunds', async () => {
    const { svc, adapter, b } = setup();
    adapter.refund.mockResolvedValueOnce({
      providerRef: null,
      status: 'PENDING',
      raw: null,
    } as never);
    expect(
      (await svc.refund('o1', { amount: 100 }, undefined, ROOT)).status,
    ).toBe('PENDING');
    adapter.refund.mockRejectedValueOnce(new Error('insufficient balance'));
    const r = await svc.refund('o1', { amount: 100 }, undefined, ROOT);
    expect(r).toMatchObject({
      status: 'FAILED',
      failureReason: 'insufficient balance',
    });
    expect(b.afterNames()).toEqual(['payment.refund-failed']);
  });

  it('gives back unwanted payments automatically (failures only logged)', async () => {
    const { svc, prisma } = setup();
    prisma.payment.findUniqueOrThrow.mockResolvedValueOnce({
      orderId: 'o1',
      amount: 7000n,
      amountRefunded: 1000n,
    });
    await svc.autoRefund('pay2', 'Paid twice', ROOT);
    expect(prisma.refund.create.mock.calls[0][0].data).toMatchObject({
      amount: 6000n,
      idempotencyKey: 'auto-pay2',
      reason: 'Paid twice',
    });
    prisma.payment.findUniqueOrThrow.mockResolvedValueOnce({
      orderId: 'o1',
      amount: 7000n,
      amountRefunded: 7000n,
    });
    await svc.autoRefund('pay2', 'x', ROOT);
    expect(prisma.refund.create).toHaveBeenCalledTimes(1);
    prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 10000n } });
    await expect(svc.autoRefund('pay2', 'x', ROOT)).resolves.toBeUndefined();
  });

  it('settles refunds the provider answered as pending, once', async () => {
    const { svc, prisma, adapter, adapters, b, stored, paymentRow } = setup();
    const refundStatus = vi.fn<AnyFn>(async () => ({
      providerRef: 're_1',
      status: 'SUCCEEDED',
      raw: {},
    }));
    Object.assign(adapter, { refundStatus });
    const row = { ...stored, providerRef: 're_1', payment: paymentRow };
    prisma.refund.findMany.mockResolvedValue([row, { ...row, id: 'r2' }]);
    refundStatus.mockRejectedValueOnce(new Error('timeout'));
    expect(await svc.settlePending(new Date('2026-11-14T01:00:00Z'))).toEqual({
      checked: 2,
      settled: 1,
    });
    expect(prisma.refund.findMany.mock.calls[0][0].where.createdAt.lte).toEqual(
      new Date('2026-11-14T00:55:00Z'),
    );
    expect(refundStatus.mock.calls[1][1]).toEqual({
      id: 'r2',
      providerRef: 're_1',
    });
    expect(
      prisma.paymentTransaction.create.mock.calls[0][0].data,
    ).toMatchObject({
      source: 'reconciliation',
      succeeded: true,
    });
    expect(b.afterNames()).toEqual(['payment.refunded']);
    // Already settled (a concurrent run): nothing is recorded twice.
    expect((await svc.settlePending()).settled).toBe(0);
    // Still pending, or a provider that can't be asked: left for later.
    stored.status = 'PENDING';
    refundStatus.mockResolvedValueOnce({
      providerRef: null,
      status: 'PENDING',
      raw: {},
    });
    refundStatus.mockResolvedValueOnce({
      providerRef: null,
      status: 'FAILED',
      reason: 'Expired card',
      raw: {},
    });
    expect((await svc.settlePending()).settled).toBe(1);
    expect(stored).toMatchObject({
      status: 'FAILED',
      failureReason: 'Expired card',
    });
    adapters.for.mockReturnValue({ refund: vi.fn() } as never);
    expect(await svc.settlePending(new Date(), 0)).toEqual({
      checked: 2,
      settled: 0,
    });
  });

  it('sanitizes provider payloads', () => {
    expect(
      sanitize({
        a: 1n,
        list: [{ token: 't', ok: 'y' }],
        deep: { b: { c: { d: { e: { f: { g: 1 } } } } } },
      }),
    ).toEqual({
      a: '1',
      list: [{ token: '[redacted]', ok: 'y' }],
      deep: { b: { c: { d: { e: { f: { g: '[…]' } } } } } },
    });
    expect(sanitize(null)).toEqual({});
  });
});

describe('payments wiring', () => {
  it('the listener cancels open attempts of cancelled orders', async () => {
    const payments = stubService();
    await new PaymentsListener(payments as never).onCanceled({
      data: { orderId: 'o1' },
    } as never);
    expect(payments.cancelOpen).toHaveBeenCalledWith('o1');
  });

  it('runs and schedules checkout jobs', async () => {
    const carts = { purge: vi.fn<AnyFn>(async () => 2) };
    const orders = { expireUnpaid: vi.fn<AnyFn>(async () => 1) };
    const payments = {
      reconcile: vi.fn<AnyFn>(async () => ({ checked: 0, changed: 0 })),
    };
    const p = new CheckoutJobsProcessor(
      carts as never,
      orders as never,
      payments as never,
    );
    const job = (name: string) => ({ name, id: '1', data: {} }) as never;
    expect(await p.process(job('carts-purge'))).toEqual({ purged: 2 });
    expect(await p.process(job('orders-expire-unpaid'))).toEqual({
      canceled: 1,
    });
    expect(await p.process(job('payments-reconcile'))).toEqual({
      checked: 0,
      changed: 0,
    });
    expect(await p.process(job('other'))).toEqual({
      skipped: 'unknown job other',
    });
    const queue = { upsertJobScheduler: vi.fn<AnyFn>() };
    await new CheckoutJobsScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'expire-unpaid-orders',
      'reconcile-payments',
      'purge-carts',
    ]);
  });

  it('storefront payment routes check access first', async () => {
    const payments = stubService();
    const orders = stubService('o1');
    const c = new StorefrontPaymentsController(
      payments as never,
      orders as never,
    );
    await c.pay(
      {} as never,
      'US-1',
      { method: 'card', returnUrl: 'https://x' },
      { ip: '::ffff:1.2.3.4' } as never,
      'tok',
    );
    expect(payments.pay.mock.calls[0]).toEqual([
      'o1',
      { method: 'card', returnUrl: 'https://x' },
      '1.2.3.4',
    ]);
    await c.pay({} as never, 'US-1', {} as never, {} as never);
    expect(payments.pay.mock.calls[1][2]).toBe('127.0.0.1');
    await c.methods({} as never, 'US-1');
    await c.complete({} as never, 'US-1', 'pay1', { params: { a: 'b' } });
    expect(payments.handleReturn).toHaveBeenCalledWith('o1', 'pay1', {
      a: 'b',
    });
  });

  it('cart payment methods use the billing (else shipping) country and amount due', async () => {
    const carts = stubService();
    carts.price.mockResolvedValue({
      cart: {
        currencyCode: 'USD',
        billingAddress: null,
        shippingAddress: { countryCode: 'US' },
      },
      amountDue: 900n,
    });
    const config = stubService([{ id: 'm', providerId: 'p', code: 'card' }]);
    const out = await new CartPaymentMethodsController(
      carts as never,
      config as never,
    ).methods({ storeId: 's1', localeChain: ['en-US'] } as never);
    expect(out).toEqual([{ code: 'card' }]);
    expect(config.eligibleMethods.mock.calls[0][0]).toMatchObject({
      countryCode: 'US',
      amount: 900n,
    });
    carts.price.mockResolvedValue({
      cart: {
        currencyCode: 'USD',
        billingAddress: null,
        shippingAddress: null,
      },
      amountDue: 1n,
    });
    await new CartPaymentMethodsController(
      carts as never,
      config as never,
    ).methods({} as never);
    expect(config.eligibleMethods.mock.calls[1][0].countryCode).toBeNull();
  });

  it('webhooks answer with the provider’s status and body', async () => {
    const payments = stubService();
    const c = new PaymentWebhooksController(payments as never);
    const res = () => ({
      status: vi.fn<AnyFn>(),
      json: vi.fn<AnyFn>(),
      end: vi.fn<AnyFn>(),
    });
    payments.webhook.mockResolvedValueOnce({
      status: 200,
      body: { RspCode: '00' },
    });
    const r1 = res();
    await c.get(
      'p1',
      { headers: {}, query: { vnp_Amount: 1 } } as never,
      r1 as never,
    );
    expect(payments.webhook.mock.calls[0][1]).toMatchObject({
      rawBody: Buffer.from(''),
      query: { vnp_Amount: '1' },
    });
    expect(r1.json).toHaveBeenCalledWith({ RspCode: '00' });
    payments.webhook.mockResolvedValueOnce({ status: 204 });
    const r2 = res();
    await c.post(
      'p1',
      { headers: {}, query: {}, rawBody: Buffer.from('{}') } as never,
      r2 as never,
    );
    expect(r2.status).toHaveBeenCalledWith(204);
    expect(r2.end).toHaveBeenCalled();
  });

  it('admin routes delegate; refunds return the refund just made', async () => {
    const payments = stubService({
      refunds: [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }],
    });
    const refunds = stubService({ id: 'r1' });
    const prisma = fakePrisma();
    const c = new PaymentsAdminController(
      payments as never,
      refunds as never,
      stubService() as never,
      prisma as never,
    );
    expect(await exerciseController(c)).toMatchObject({ failed: 0 });
    expect(await c.refund('o1', {}, ROOT, 'key')).toEqual({ id: 'r1' });
    expect(refunds.refund.mock.calls.at(-1)![2]).toBe('key');
    await c.refund('o1', {}, ROOT, '');
    expect(refunds.refund.mock.calls.at(-1)![2]).toBeUndefined();
    prisma.paymentWebhookEvent.count.mockResolvedValue(0);
    expect(
      await c.webhooks({ page: 1, limit: 20, skip: 0, order: 'desc' } as never),
    ).toEqual({ data: [], total: 0, page: 1, limit: 20 });
  });
});
