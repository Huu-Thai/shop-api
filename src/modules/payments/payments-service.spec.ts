import { fakeBus } from '../../testing/fake-bus.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { fakeStores, storeSnap } from '../../testing/stores.js';
import { PaymentsService } from './payments.service.js';
import { InvalidSignatureError } from './providers/types.js';

const ADMIN = { type: 'admin' as const, id: 'a1', label: 'root@shop.test' };
const provider = {
  id: 'prov1',
  code: 'STRIPE',
  mode: 'TEST',
  credentials: 'sealed',
};

const payment = (extra: object = {}) => ({
  id: 'pay1',
  orderId: 'o1',
  providerId: 'prov1',
  providerCode: 'STRIPE',
  status: 'PENDING',
  amount: 5000n,
  amountRefunded: 0n,
  currencyCode: 'USD',
  providerRef: 'pi_1',
  captureRef: null,
  action: { type: 'CLIENT_SECRET', clientSecret: 'x' },
  failureReason: null,
  capturedAt: null,
  createdAt: new Date('2026-11-14T00:00:00Z'),
  method: { code: 'card' },
  provider,
  ...extra,
});

const facts = (extra: object = {}) => ({
  id: 'o1',
  number: 'US-1',
  storeId: 's1',
  email: 'a@b.co',
  localeCode: 'en-US',
  status: 'PENDING_PAYMENT',
  currencyCode: 'USD',
  amountDue: 5000n,
  amountPaid: 0n,
  billingCountry: 'US',
  ...extra,
});

function setup(env = 'development') {
  const prisma = fakePrisma();
  const b = fakeBus(prisma);
  let locked = 'PENDING';
  prisma.$queryRaw.mockImplementation(async () => [{ status: locked }]);
  prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 5000n } });
  const orders = { paymentFacts: vi.fn<AnyFn>(async () => facts()) };
  const paymentConfig = {
    eligibleMethods: vi.fn<AnyFn>(async () => [
      {
        id: 'm1',
        providerId: 'prov1',
        code: 'card',
        name: 'Card',
        provider: 'STRIPE',
      },
    ]),
  };
  const adapter = {
    code: 'STRIPE',
    createPayment: vi.fn<AnyFn>(async () => ({
      providerRef: 'pi_1',
      action: { type: 'CLIENT_SECRET', clientSecret: 's' },
      raw: { client_secret: 's' },
    })),
    handleReturn: vi.fn<AnyFn>(async () => ({
      type: 'CAPTURED',
      eventId: 'e',
      eventType: 'return',
      providerRef: 'pi_1',
      amount: 5000n,
      raw: {},
    })),
    parseWebhook: vi.fn<AnyFn>(async () => ({
      type: 'CAPTURED',
      eventId: 'evt_1',
      eventType: 'payment_intent.succeeded',
      providerRef: 'pi_1',
      captureRef: 'ch_1',
      amount: 5000n,
      raw: {},
    })),
    capture: vi.fn<AnyFn>(async () => ({
      type: 'CAPTURED',
      eventId: 'c',
      eventType: 'capture',
      providerRef: 'pi_1',
      amount: 5000n,
      raw: {},
    })) as ReturnType<typeof vi.fn> | undefined,
    status: vi.fn<AnyFn>(async () => ({
      type: 'CAPTURED',
      eventId: 's',
      eventType: 'status',
      providerRef: 'pi_1',
      amount: 5000n,
      raw: {},
    })),
    cancel: vi.fn<AnyFn>(async () => undefined),
    refund: vi.fn<AnyFn>(),
    ack: vi.fn<AnyFn>((reason: string) => ({
      status: reason === 'ok' ? 200 : 400,
      body: reason,
    })),
  };
  const adapters = { for: vi.fn<AnyFn>(() => adapter) };
  const refunds = {
    autoRefund: vi.fn<AnyFn>(async () => undefined),
    settlePending: vi.fn<AnyFn>(async () => ({ checked: 1, settled: 1 })),
  };
  const stores = fakeStores(storeSnap({ baseUrl: 'https://shop.example' }));
  const values: Record<string, unknown> = {
    env,
    publicUrl: 'https://api.shop.example',
    corsOrigins: ['https://www.shop.example'],
  };
  const config = { get: vi.fn<AnyFn>((k: string) => values[k]) };
  const svc = new PaymentsService(
    prisma as never,
    b.bus,
    orders as never,
    paymentConfig as never,
    adapters as never,
    refunds as never,
    stores as never,
    config as never,
  );
  return {
    prisma,
    b,
    svc,
    orders,
    paymentConfig,
    adapter,
    adapters,
    refunds,
    setLocked: (s: string) => (locked = s),
  };
}

describe('PaymentsService.pay', () => {
  it('offers methods and starts a payment through the provider', async () => {
    const { svc, prisma, adapter, b } = setup();
    expect(await svc.methodsForOrder('o1')).toEqual([
      { code: 'card', name: 'Card', provider: 'STRIPE' },
    ]);
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.paymentProvider.findUniqueOrThrow.mockResolvedValue(provider);
    prisma.payment.create.mockResolvedValue(
      payment({ action: null, providerRef: null }),
    );
    prisma.payment.update.mockResolvedValue(payment());
    const r = await svc.pay(
      'o1',
      { method: 'card', returnUrl: 'https://shop.example/r' },
      '1.2.3.4',
    );
    expect(r).toMatchObject({
      id: 'pay1',
      status: 'PENDING',
      amount: { amount: 5000, formatted: '$50.00' },
      action: { type: 'CLIENT_SECRET' },
    });
    expect(adapter.createPayment.mock.calls[0][0]).toMatchObject({
      amount: 5000n,
      minorUnits: 2,
      cancelUrl: 'https://shop.example/r',
      notifyUrl: 'https://api.shop.example/api/v1/webhooks/payments/prov1',
    });
    expect(prisma.paymentTransaction.create.mock.calls[0][0].data.raw).toEqual({
      client_secret: '[redacted]',
    });
    expect(b.afterNames()).toEqual([]);
  });

  it('cash on delivery is accepted at once', async () => {
    const { svc, prisma, adapter, b } = setup();
    prisma.paymentProvider.findUniqueOrThrow.mockResolvedValue({
      ...provider,
      code: 'COD',
    });
    prisma.payment.create.mockResolvedValue(payment());
    prisma.payment.update.mockResolvedValue(
      payment({ status: 'AWAITING_COLLECTION', providerCode: 'COD' }),
    );
    adapter.createPayment.mockResolvedValueOnce({
      providerRef: 'cod',
      action: { type: 'NONE' },
      accepted: true,
      raw: null,
    } as never);
    const r = await svc.pay(
      'o1',
      { method: 'card', returnUrl: 'http://localhost/r' },
      '::1',
    );
    expect(r.action).toBeNull();
    expect(prisma.payment.update.mock.calls[0][0].data.status).toBe(
      'AWAITING_COLLECTION',
    );
    expect(b.afterNames()).toEqual(['payment.accepted']);
  });

  it('shows a pending attempt again, replaces one with another method', async () => {
    const { svc, prisma, adapter } = setup();
    prisma.payment.findFirst.mockResolvedValueOnce(payment());
    expect(
      (await svc.pay('o1', { method: 'card', returnUrl: 'https://x/r' }, 'ip'))
        .id,
    ).toBe('pay1');
    expect(adapter.createPayment).not.toHaveBeenCalled();
    prisma.payment.findFirst.mockResolvedValueOnce(
      payment({ method: { code: 'paypal' } }),
    );
    prisma.paymentProvider.findUniqueOrThrow.mockResolvedValue(provider);
    prisma.payment.create.mockResolvedValue(payment({ id: 'pay2' }));
    prisma.payment.update.mockResolvedValue(payment({ id: 'pay2' }));
    await svc.pay('o1', { method: 'card', returnUrl: 'https://x/r' }, 'ip');
    expect(adapter.cancel).toHaveBeenCalled();
    expect(prisma.payment.update.mock.calls[0][0].data).toMatchObject({
      status: 'CANCELED',
      failureReason: 'Replaced by another payment attempt',
    });
  });

  it('refuses orders not waiting for payment and unknown methods; records provider failures', async () => {
    const { svc, prisma, orders, adapter, b } = setup();
    orders.paymentFacts.mockResolvedValueOnce(facts({ status: 'PROCESSING' }));
    await expect(
      svc.pay('o1', { method: 'card', returnUrl: 'https://x' }, 'ip'),
    ).rejects.toThrow('not waiting');
    await expect(
      svc.pay('o1', { method: 'bank', returnUrl: 'https://x' }, 'ip'),
    ).rejects.toThrow('"bank" is not available');
    prisma.paymentProvider.findUniqueOrThrow.mockResolvedValue(provider);
    prisma.payment.create.mockResolvedValue(payment());
    prisma.payment.findUnique.mockResolvedValue(payment());
    adapter.createPayment.mockRejectedValueOnce(new Error('Card network down'));
    await expect(
      svc.pay('o1', { method: 'card', returnUrl: 'https://x' }, 'ip'),
    ).rejects.toThrow('could not be started: Card network down');
    expect(b.afterNames()).toEqual(['payment.failed']);
  });

  it('in production, return URLs must be https on the storefront', async () => {
    const { svc, prisma } = setup('production');
    await expect(
      svc.pay(
        'o1',
        { method: 'card', returnUrl: 'http://shop.example/r' },
        'ip',
      ),
    ).rejects.toThrow('https');
    await expect(
      svc.pay(
        'o1',
        { method: 'card', returnUrl: 'https://evil.example/r' },
        'ip',
      ),
    ).rejects.toThrow('own domain');
    await expect(
      svc.pay(
        'o1',
        {
          method: 'card',
          returnUrl: 'https://shop.example/r',
          cancelUrl: 'https://evil.example',
        },
        'ip',
      ),
    ).rejects.toThrow('own domain');
    prisma.payment.findFirst.mockResolvedValue(payment());
    await svc.pay(
      'o1',
      { method: 'card', returnUrl: 'https://www.shop.example/r' },
      'ip',
    );
  });
});

describe('PaymentsService returns, webhooks and apply', () => {
  it('verifies returns', async () => {
    const { svc, prisma, adapter, b } = setup();
    prisma.payment.findUnique.mockResolvedValue(payment());
    prisma.payment.findFirst.mockResolvedValue(payment());
    await svc.handleReturn('o1', 'pay1', {});
    expect(b.afterNames()).toEqual(['payment.captured']);
    await expect(svc.handleReturn('o2', 'pay1', {})).rejects.toThrow(
      'not found',
    );
    adapter.handleReturn.mockRejectedValueOnce(
      new InvalidSignatureError('bad'),
    );
    await expect(svc.handleReturn('o1', 'pay1', {})).rejects.toThrow(
      'could not be verified',
    );
    adapter.handleReturn.mockRejectedValueOnce(new Error('timeout'));
    await expect(svc.handleReturn('o1', 'pay1', {})).rejects.toThrow('timeout');
    prisma.payment.findUnique.mockResolvedValue(
      payment({ status: 'CAPTURED' }),
    );
    expect((await svc.handleReturn('o1', 'pay1', {})).action).toBeNull();
    prisma.payment.findUnique.mockResolvedValue(null);
    await expect(svc.handleReturn('o1', 'pay1', {})).rejects.toThrow(
      'not found',
    );
  });

  it('applies verified webhooks once and answers like the provider expects', async () => {
    const { svc, prisma, adapter, b } = setup();
    prisma.paymentProvider.findUnique.mockResolvedValueOnce(null);
    expect(await svc.webhook('nope', {} as never)).toEqual({ status: 404 });
    prisma.paymentProvider.findUnique.mockResolvedValue(provider);
    prisma.payment.findFirst.mockResolvedValue(payment());
    expect(await svc.webhook('prov1', {} as never)).toEqual({
      status: 200,
      body: 'ok',
    });
    expect(
      prisma.paymentWebhookEvent.createMany.mock.calls[0][0].data[0],
    ).toMatchObject({
      providerEventId: 'evt_1',
      status: 'PROCESSED',
      error: null,
    });
    expect(b.afterNames()).toEqual([
      'payment.captured',
      'payment.webhook-received',
    ]);

    prisma.paymentWebhookEvent.findUnique.mockResolvedValueOnce({
      status: 'PROCESSED',
    });
    expect((await svc.webhook('prov1', {} as never)).body).toBe('duplicate');
    prisma.paymentWebhookEvent.findUnique.mockResolvedValueOnce({
      status: 'FAILED',
    });
    expect((await svc.webhook('prov1', {} as never)).body).toBe('error');

    adapter.parseWebhook.mockRejectedValueOnce(
      new InvalidSignatureError('sig'),
    );
    expect((await svc.webhook('prov1', {} as never)).body).toBe(
      'invalid-signature',
    );
    adapter.parseWebhook.mockRejectedValueOnce(new Error('bad json'));
    expect((await svc.webhook('prov1', {} as never)).body).toBe('error');

    prisma.payment.findFirst.mockRejectedValueOnce(new Error('db down'));
    expect((await svc.webhook('prov1', {} as never)).body).toBe('error');
    expect(
      prisma.paymentWebhookEvent.createMany.mock.calls.at(-1)![0].data[0],
    ).toMatchObject({ status: 'FAILED', error: 'db down' });

    adapter.parseWebhook.mockResolvedValueOnce({
      type: 'IGNORED',
      eventId: 'e9',
      eventType: 'other',
      raw: {},
    } as never);
    await svc.webhook('prov1', {} as never);
    expect(
      prisma.paymentWebhookEvent.createMany.mock.calls.at(-1)![0].data[0]
        .status,
    ).toBe('IGNORED');

    prisma.payment.findFirst.mockResolvedValueOnce(null);
    expect((await svc.webhook('prov1', {} as never)).body).toBe(
      'unknown-payment',
    );
    expect(
      prisma.paymentWebhookEvent.createMany.mock.calls.at(-1)![0].data[0],
    ).toMatchObject({ status: 'FAILED', error: 'unknown-payment' });
  });

  it('captures once, refuses wrong amounts, refunds unwanted money', async () => {
    const { svc, prisma, b, setLocked, orders, refunds } = setup();
    prisma.payment.findFirst.mockResolvedValue(payment());
    const captured = {
      type: 'CAPTURED',
      eventId: 'e',
      eventType: 't',
      providerRef: 'pi_1',
      captureRef: 'ch_1',
      amount: 5000n,
      raw: {},
    } as const;
    expect(
      await svc.apply(
        provider as never,
        { ...captured, providerRef: null } as never,
        'webhook',
      ),
    ).toBe('unknown-payment');
    expect(
      await svc.apply(
        provider as never,
        { ...captured, amount: 4000n },
        'webhook',
      ),
    ).toBe('amount-mismatch');
    expect(prisma.paymentTransaction.create.mock.calls[0][0].data.type).toBe(
      'FAILURE',
    );
    expect(
      await svc.apply(
        provider as never,
        { ...captured, amount: null } as never,
        'webhook',
      ),
    ).toBe('ok');
    expect(prisma.payment.update.mock.calls[0][0].data).toMatchObject({
      status: 'CAPTURED',
      captureRef: 'ch_1',
    });
    expect((b.after.at(-1) as unknown as { data: object }).data).toMatchObject({
      totalCaptured: '5000',
    });
    expect(refunds.autoRefund).not.toHaveBeenCalled();

    orders.paymentFacts.mockResolvedValueOnce(facts({ status: 'CANCELED' }));
    await svc.apply(provider as never, captured, 'webhook');
    expect(refunds.autoRefund).toHaveBeenLastCalledWith(
      'pay1',
      'The order was cancelled before the payment completed',
      expect.anything(),
    );
    prisma.payment.aggregate.mockResolvedValueOnce({
      _sum: { amount: 10000n },
    });
    await svc.apply(provider as never, captured, 'webhook');
    expect(refunds.autoRefund).toHaveBeenLastCalledWith(
      'pay1',
      'The order was already paid',
      expect.anything(),
    );

    setLocked('CAPTURED');
    expect(await svc.apply(provider as never, captured, 'webhook')).toBe(
      'duplicate',
    );
    expect(
      await svc.apply(
        provider as never,
        { ...captured, type: 'FAILED' },
        'webhook',
      ),
    ).toBe('duplicate');
    setLocked('PENDING');
    expect(
      await svc.apply(
        provider as never,
        { ...captured, type: 'FAILED', reason: 'Declined' } as never,
        'webhook',
      ),
    ).toBe('ok');
    expect(prisma.payment.update.mock.calls.at(-1)![0].data).toEqual({
      status: 'FAILED',
      failureReason: 'Declined',
    });
    await svc.apply(
      provider as never,
      { ...captured, type: 'CANCELED' },
      'webhook',
    );
    expect(prisma.payment.update.mock.calls.at(-1)![0].data).toEqual({
      status: 'CANCELED',
      failureReason: 'canceled',
    });
  });

  it('captures approved payments (PayPal) when the provider can', async () => {
    const { svc, prisma, adapter } = setup();
    const approved = {
      type: 'APPROVED',
      eventId: 'e',
      eventType: 't',
      providerRef: 'pi_1',
      raw: {},
    } as never;
    prisma.payment.findFirst.mockResolvedValue(payment());
    expect(await svc.apply(provider as never, approved, 'webhook')).toBe('ok');
    expect(adapter.capture).toHaveBeenCalled();
    adapter.capture = undefined;
    expect(await svc.apply(provider as never, approved, 'webhook')).toBe('ok');
    prisma.payment.findFirst.mockResolvedValue(payment({ status: 'CAPTURED' }));
    expect(await svc.apply(provider as never, approved, 'webhook')).toBe(
      'duplicate',
    );
    expect(
      await svc.apply(
        provider as never,
        { type: 'IGNORED' } as never,
        'webhook',
      ),
    ).toBe('ok');
  });
});

describe('PaymentsService staff operations and jobs', () => {
  it('captures cash on delivery once', async () => {
    const { svc, prisma, b } = setup();
    prisma.payment.findUnique.mockResolvedValue(
      payment({ status: 'AWAITING_COLLECTION', providerCode: 'COD' }),
    );
    prisma.payment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.paymentTransaction.findMany.mockResolvedValue([
      {
        type: 'CAPTURE',
        amount: 5000n,
        succeeded: true,
        providerRef: null,
        source: 'admin',
        createdAt: new Date(),
      },
    ]);
    const v = await svc.captureCod('pay1', ADMIN);
    expect(v.transactions[0].amount).toEqual({
      amount: 5000,
      formatted: '$50.00',
    });
    await svc.captureCod('pay1', ADMIN);
    expect(b.afterNames()).toEqual(['payment.captured']);
    prisma.payment.findUnique.mockResolvedValue(payment());
    await expect(svc.captureCod('pay1', ADMIN)).rejects.toThrow(
      'waiting for collection',
    );
  });

  it('cancels open attempts (provider errors are only logged)', async () => {
    const { svc, prisma, adapter, b, setLocked } = setup();
    prisma.payment.findMany.mockResolvedValue([
      payment(),
      payment({ id: 'pay2' }),
    ]);
    adapter.cancel.mockRejectedValueOnce(new Error('already expired'));
    await svc.cancelOpen('o1');
    expect(b.afterNames()).toEqual(['payment.canceled', 'payment.canceled']);
    setLocked('CAPTURED');
    await svc.cancelOpen('o1');
    expect(b.afterNames()).toHaveLength(2);
  });

  it('reconciles stale pending payments', async () => {
    const { svc, prisma, adapter, refunds } = setup();
    prisma.payment.findMany.mockResolvedValue([
      payment(),
      payment({ id: 'p2' }),
      payment({ id: 'p3' }),
    ]);
    prisma.payment.findFirst.mockResolvedValue(payment());
    adapter.status
      .mockResolvedValueOnce({ type: 'IGNORED' } as never)
      .mockRejectedValueOnce(new Error('timeout'));
    expect(await svc.reconcile(new Date('2026-11-14T01:00:00Z'))).toEqual({
      checked: 3,
      changed: 1,
      refunds: { checked: 1, settled: 1 },
    });
    expect(refunds.settlePending).toHaveBeenCalledWith(
      new Date('2026-11-14T01:00:00Z'),
      undefined,
    );
    expect(prisma.payment.findMany.mock.calls[0][0].where.createdAt.lt).toEqual(
      new Date('2026-11-14T00:55:00Z'),
    );
  });

  it('lists an order’s payments and refunds', async () => {
    const { svc, prisma, adapters } = setup();
    prisma.payment.findMany.mockResolvedValue([payment({ method: null })]);
    prisma.refund.findMany.mockResolvedValue([
      {
        id: 'r1',
        paymentId: 'pay1',
        amount: 100n,
        currencyCode: 'VND',
        status: 'SUCCEEDED',
        reason: null,
        providerRef: null,
        failureReason: null,
        restock: false,
        createdAt: new Date(),
      },
    ]);
    const r = await svc.forOrder('o1');
    expect(r.payments[0].method).toBeNull();
    expect(r.refunds[0].amount.amount).toBe(100);
    svc.adapterFor(provider as never);
    expect(adapters.for).toHaveBeenCalled();
  });
});
