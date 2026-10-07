import { sha256 } from '../../common/auth/api-key-format.js';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { fakeStores } from '../../testing/stores.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { orderAccessToken, uuidFromName } from './order-ids.js';
import { OrdersService } from './orders.service.js';
import { formatNumber, nextNumber } from './sequences.js';

const ADMIN = { type: 'admin' as const, id: 'a1', label: 'root@shop.test' };

const ctx = (customer?: string): StoreContext =>
  ({
    storeId: 's1',
    websiteId: 'w1',
    localeCode: 'en-US',
    pricesIncludeTax: false,
    ...(customer ? { customer: { id: customer, email: 'c@x.co' } } : {}),
  }) as StoreContext;

const address = {
  firstName: 'A',
  lastName: 'B',
  countryCode: 'US',
  city: 'LA',
  line1: '1 Main',
};

const priced = (extra: object = {}, cartExtra: object = {}) => ({
  cart: {
    id: 'cart1',
    customerId: null,
    email: 'g@x.co',
    currencyCode: 'USD',
    shippingAddress: address,
    billingAddress: null,
    ...cartExtra,
  },
  ctx: { websiteId: 'w1' },
  customerGroupCode: 'guest',
  lines: [
    {
      itemId: 'i1',
      variantId: 'v1',
      productId: 'p1',
      sku: 'TEE',
      name: 'Tee',
      type: 'SIMPLE',
      quantity: 2,
      options: [],
      attributes: {},
      components: [],
      unitPrice: 2500n,
      rowTotal: 5000n,
      discount: 500n,
      taxAmount: 450n,
      taxRate: '0.1000',
      available: true,
    },
    {
      itemId: 'i2',
      variantId: 'vk',
      productId: 'pk',
      sku: 'KIT',
      name: 'Kit',
      type: 'BUNDLE',
      quantity: 1,
      options: [],
      attributes: {},
      components: [{ option: 'a', variantId: 'v1', sku: 'TEE', quantity: 2 }],
      unitPrice: 4000n,
      rowTotal: 4000n,
      discount: 0n,
      taxAmount: 400n,
      taxRate: '0.1000',
      available: true,
    },
    { itemId: 'i3', variantId: 'vx', available: false, components: [] },
  ],
  evaluation: {
    result: {
      applied: [
        {
          promotionId: 'pr1',
          label: 'Sale',
          discount: 500n,
          couponCode: 'SAVE',
        },
      ],
      freeShipping: false,
    },
    coupon: { code: 'SAVE', status: 'APPLIED' },
  },
  shipping: { code: 'std', name: 'Standard' },
  shippingAmount: 800n,
  shippingDiscount: 0n,
  subtotal: 9000n,
  discountTotal: 500n,
  taxTotal: 850n,
  grandTotal: 10150n,
  loyaltyPoints: 0,
  loyaltyAmount: 0n,
  amountDue: 10150n,
  taxBreakdown: [{ name: 'VAT', rate: '0.1', amount: 850n }],
  requiresShipping: true,
  missing: [] as string[],
  warnings: [] as string[],
  ...extra,
});

const state = (extra: object = {}) => ({
  id: 'o1',
  number: 'US-000001',
  storeId: 's1',
  websiteId: 'w1',
  websiteCode: 'us',
  customerId: null,
  status: 'PENDING_PAYMENT',
  paymentStatus: 'UNPAID',
  fulfillmentStatus: 'UNFULFILLED',
  currencyCode: 'USD',
  subtotal: 9000n,
  discountTotal: 500n,
  shippingTotal: 800n,
  taxTotal: 850n,
  grandTotal: 10150n,
  amountDue: 10150n,
  amountPaid: 0n,
  ...extra,
});

function setup(order: object | null = state()) {
  const prisma = fakePrisma();
  const b = fakeBus(prisma);
  let current = order;
  prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('document_sequences')
      ? [{ value: 7n }]
      : current
        ? [current]
        : [],
  );
  const carts = {
    require: vi.fn<AnyFn>(async () => ({ id: 'cart1', customerId: null })),
  };
  const pricer = { price: vi.fn<AnyFn>(async () => priced()) };
  const reservations = {
    reserve: vi.fn<AnyFn>(async (dto: { variantId: string }) => ({
      managed: dto.variantId !== 'vk',
    })),
    release: vi.fn<AnyFn>(async () => undefined),
  };
  const redemptions = {
    redeemEvaluation: vi.fn<AnyFn>(async () => undefined),
    release: vi.fn<AnyFn>(async () => undefined),
  };
  const loyalty = {
    redeem: vi.fn<AnyFn>(async () => undefined),
    reverse: vi.fn<AnyFn>(async () => undefined),
  };
  const config = { get: vi.fn<AnyFn>(() => ({ jwtSecret: 'secret' })) };
  const redis = {
    set: vi.fn<AnyFn>(async () => 'OK'),
    del: vi.fn<AnyFn>(async () => 1),
  };
  const svc = new OrdersService(
    prisma as never,
    b.bus,
    carts as never,
    pricer as never,
    reservations as never,
    redemptions as never,
    loyalty as never,
    fakeStores() as never,
    config as never,
    redis as never,
  );
  return {
    prisma,
    b,
    svc,
    carts,
    pricer,
    reservations,
    redemptions,
    loyalty,
    redis,
    setState: (o: object | null) => (current = o),
  };
}

const KEY = 'checkout-key-1';
const unique = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target },
  });

describe('order ids and sequences', () => {
  it('derives stable ids and tokens', () => {
    const id = uuidFromName('order:c:k');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuidFromName('order:c:k')).toBe(id);
    expect(uuidFromName('order:c:j')).not.toBe(id);
    expect(orderAccessToken('s', id)).toBe(orderAccessToken('s', id));
    expect(orderAccessToken('t', id)).not.toBe(orderAccessToken('s', id));
  });

  it('numbers documents', async () => {
    const tx = { $queryRaw: vi.fn<AnyFn>(async () => [{ value: 41 }]) };
    expect(await nextNumber(tx as never, 'order:us')).toBe(41n);
    expect(formatNumber('US', 42n)).toBe('US-000042');
    expect(formatNumber('INV', 3n, 3)).toBe('INV-003');
  });
});

describe('OrdersService.place', () => {
  it('reserves, records promotions, writes the order and its lines', async () => {
    const { svc, prisma, b, reservations, redemptions, redis } = setup();
    const r = await svc.place(ctx(), 'tok', KEY);
    const orderId = uuidFromName(`order:cart1:${KEY}`);
    expect(r).toEqual({
      orderId,
      number: 'US-000007',
      accessToken: orderAccessToken('secret', orderId),
      created: true,
    });
    expect(
      reservations.reserve.mock.calls.map((c) => [
        c[0].variantId,
        c[0].quantity,
      ]),
    ).toEqual([
      ['v1', 2],
      ['v1', 2],
    ]);
    expect(redemptions.redeemEvaluation.mock.calls[0][0]).toMatchObject({
      orderRef: orderId,
    });
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: orderId,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'UNPAID',
      accessTokenHash: sha256(r.accessToken),
      couponCode: 'SAVE',
      shippingTotal: 800n,
      discounts: [
        {
          promotionId: 'pr1',
          label: 'Sale',
          discount: '500',
          couponCode: 'SAVE',
        },
      ],
    });
    expect(data.addresses.create.map((a: { type: string }) => a.type)).toEqual([
      'SHIPPING',
      'BILLING',
    ]);
    const items = prisma.orderItem.create.mock.calls.map((c) => c[0].data);
    expect(
      items.map((i) => [i.sku, i.quantity, i.parentItemId ?? null]),
    ).toEqual([
      ['TEE', 2, null],
      ['KIT', 1, null],
      ['TEE', 2, 'new-id'],
    ]);
    expect(items[0].reservationGroupId).toBe(
      uuidFromName(`reservation:${orderId}:i1`),
    );
    expect(b.afterNames()).toEqual(['order.placed']);
    expect(redis.del).toHaveBeenCalled();
  });

  it('orders paid in full with points are processed at once', async () => {
    const { svc, pricer, loyalty, prisma, b, carts } = setup();
    carts.require.mockResolvedValue({
      id: 'cart1',
      customerId: 'cust',
    } as never);
    pricer.price.mockResolvedValue(
      priced(
        {
          loyaltyPoints: 10150,
          loyaltyAmount: 10150n,
          amountDue: 0n,
          requiresShipping: false,
          shipping: null,
          evaluation: {
            result: { applied: [], freeShipping: false },
            coupon: null,
          },
        },
        { customerId: 'cust', email: null, shippingAddress: null },
      ) as never,
    );
    await svc.place(ctx('cust'), undefined, KEY);
    expect(loyalty.redeem.mock.calls[0][0]).toBe('cust');
    expect(prisma.order.create.mock.calls[0][0].data).toMatchObject({
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      email: 'c@x.co',
      couponCode: null,
    });
    expect(b.afterNames()).toEqual(['order.placed', 'order.paid']);
  });

  it('returns the existing order for a repeated key; rejects bad keys and concurrent placement', async () => {
    const { svc, prisma, redis } = setup();
    await expect(svc.place(ctx(), 'tok', 'short')).rejects.toThrow(
      'Idempotency-Key',
    );
    prisma.order.findUnique.mockResolvedValueOnce({ id: 'o1', number: 'US-1' });
    expect(await svc.place(ctx(), 'tok', KEY)).toMatchObject({
      orderId: 'o1',
      created: false,
    });
    redis.set.mockResolvedValueOnce(null as never);
    await expect(svc.place(ctx(), 'tok', KEY)).rejects.toThrow('being placed');
  });

  it('refuses incomplete checkouts', async () => {
    const { svc, pricer, reservations } = setup();
    pricer.price.mockResolvedValue(priced({ missing: ['email'] }) as never);
    await expect(svc.place(ctx(), 'tok', KEY)).rejects.toThrow(
      "isn't complete: email",
    );
    expect(reservations.reserve).not.toHaveBeenCalled();
    pricer.price.mockResolvedValue(priced({}, { email: null }) as never);
    await expect(svc.place(ctx(), 'tok', KEY)).rejects.toThrow('email');
  });

  it('undoes earlier steps when a later one fails', async () => {
    const { svc, pricer, loyalty, reservations, redemptions, carts, prisma } =
      setup();
    carts.require.mockResolvedValue({
      id: 'cart1',
      customerId: 'cust',
    } as never);
    pricer.price.mockResolvedValue(
      priced(
        { loyaltyPoints: 100, loyaltyAmount: 100n, amountDue: 10050n },
        { customerId: 'cust' },
      ) as never,
    );
    // One undo step failing is logged; the others still run.
    reservations.release.mockRejectedValueOnce(new Error('redis down'));
    prisma.order.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.place(ctx('cust'), undefined, KEY)).rejects.toThrow(
      'db down',
    );
    expect(reservations.release).toHaveBeenCalledTimes(2);
    expect(redemptions.release).toHaveBeenCalled();
    expect(loyalty.reverse.mock.calls[0][1]).toMatchObject({
      restoreRedeemed: true,
    });
  });

  it('a lost race returns the winner’s order; a converted cart is a conflict', async () => {
    const { svc, prisma, reservations } = setup();
    prisma.order.create.mockRejectedValueOnce(
      unique('uq_orders_store_id_idempotency_key'),
    );
    prisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      number: 'US-000003',
    });
    expect(await svc.place(ctx(), 'tok', KEY)).toMatchObject({
      number: 'US-000003',
      created: false,
    });
    expect(reservations.release).not.toHaveBeenCalled();
    prisma.order.create.mockRejectedValueOnce(unique('uq_orders_cart_id'));
    await expect(svc.place(ctx(), 'tok', KEY)).rejects.toThrow(
      'already placed from this cart',
    );
    expect(reservations.release).toHaveBeenCalled();
  });
});

describe('OrdersService lifecycle', () => {
  it('accepts cash on delivery once', async () => {
    const { svc, b, setState } = setup();
    await svc.accept('o1');
    expect(b.afterNames()).toEqual(['order.accepted']);
    setState(state({ status: 'PROCESSING' }));
    await svc.accept('o1');
    expect(b.afterNames()).toHaveLength(1);
    setState(null);
    await expect(svc.accept('o1')).rejects.toThrow('not found');
  });

  it('records payments: partial, full with invoice, completion, late money', async () => {
    const { svc, prisma, b, setState } = setup();
    await svc.recordPayment('o1', 0n);
    expect(prisma.order.update).not.toHaveBeenCalled();
    await svc.recordPayment('o1', 5000n);
    expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({
      amountPaid: 5000n,
      status: 'PENDING_PAYMENT',
    });
    await svc.recordPayment('o1', 10150n);
    expect(prisma.order.update.mock.calls[1][0].data).toMatchObject({
      paymentStatus: 'PAID',
      status: 'PROCESSING',
    });
    expect(prisma.invoice.create.mock.calls[0][0].data.number).toMatch(
      /^INV-US-\d{4}-000007$/,
    );
    expect(b.afterNames()).toEqual(['order.paid']);
    setState(state({ fulfillmentStatus: 'FULFILLED', status: 'PROCESSING' }));
    await svc.recordPayment('o1', 10150n);
    expect(b.afterNames()).toEqual([
      'order.paid',
      'order.paid',
      'order.completed',
    ]);
    setState(state({ status: 'CANCELED' }));
    await svc.recordPayment('o1', 10150n);
    expect(prisma.order.update.mock.calls.at(-1)![0].data).toEqual({
      amountPaid: 10150n,
      version: { increment: 1 },
    });
    expect(b.afterNames()).toHaveLength(3);
  });

  it('records refunds once, with credit memo, restock and closing', async () => {
    const { svc, prisma, b, setState } = setup();
    setState(
      state({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        amountPaid: 10150n,
      }),
    );
    prisma.orderItem.findFirst.mockImplementation(
      async (a: { where: { id: string } }) =>
        a.where.id === 'i2'
          ? {
              id: 'i2',
              quantity: 2,
              qtyRefunded: 0,
              reservationGroupId: null,
              children: [
                { reservationGroupId: 'g-child', quantity: 4 },
                { reservationGroupId: null, quantity: 2 },
              ],
            }
          : a.where.id === 'i1'
            ? {
                id: 'i1',
                quantity: 2,
                qtyRefunded: 2,
                reservationGroupId: 'g1',
                children: [],
              }
            : a.where.id === 'i4'
              ? {
                  id: 'i4',
                  quantity: 1,
                  qtyRefunded: 0,
                  reservationGroupId: 'g4',
                  children: [],
                }
              : null,
    );
    const input = {
      orderId: 'o1',
      refundId: 'r1',
      amount: 4000n,
      totalRefunded: 4000n,
      totalCaptured: 10150n,
      restock: true,
      items: [
        { orderItemId: 'i2', quantity: 1 },
        { orderItemId: 'i1', quantity: 1 },
        { orderItemId: 'zz', quantity: 1 },
        { orderItemId: 'i4', quantity: 1 },
      ],
    };
    await svc.recordRefund(input);
    expect(prisma.creditMemo.create.mock.calls[0][0].data).toMatchObject({
      amount: 4000n,
      taxAmount: 334n,
    });
    expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({
      paymentStatus: 'PARTIALLY_REFUNDED',
      amountRefunded: 4000n,
    });
    expect((b.after[0] as unknown as { data: object }).data).toMatchObject({
      full: false,
      restock: [
        { reservationGroupId: 'g-child', quantity: 2 },
        { reservationGroupId: 'g4', quantity: 1 },
      ],
    });

    await svc.recordRefund({
      ...input,
      refundId: 'r2',
      amount: 6150n,
      totalRefunded: 10150n,
      items: [],
      restock: false,
    });
    expect(prisma.order.update.mock.calls[1][0].data).toMatchObject({
      paymentStatus: 'REFUNDED',
      status: 'CLOSED',
    });

    prisma.creditMemo.findUnique.mockResolvedValueOnce({ id: 'cm' });
    await svc.recordRefund(input);
    expect(prisma.creditMemo.create).toHaveBeenCalledTimes(2);

    // Before the capture was recorded, on a cancelled order with nothing taxable.
    setState(state({ status: 'CANCELED', amountPaid: 0n, grandTotal: 0n }));
    await svc.recordRefund({
      ...input,
      refundId: 'r3',
      totalRefunded: 20000n,
      totalCaptured: 10150n,
      items: [],
    });
    expect(prisma.order.update.mock.calls[2][0].data).toMatchObject({
      amountPaid: 10150n,
      amountRefunded: 10150n,
      paymentStatus: 'REFUNDED',
    });
    expect(prisma.order.update.mock.calls[2][0].data.status).toBeUndefined();
    expect(prisma.creditMemo.create.mock.calls[2][0].data.taxAmount).toBe(0n);
  });

  it('cancels unpaid, unshipped orders only', async () => {
    const { svc, b, setState } = setup();
    await svc.cancel('o1', ADMIN, 'Customer asked');
    expect(b.afterNames()).toEqual(['order.canceled']);
    setState(state({ status: 'CANCELED' }));
    await svc.cancel('o1', ADMIN, 'again');
    expect(b.afterNames()).toHaveLength(1);
    const refused: [object, string][] = [
      [{ paymentStatus: 'PAID' }, 'refund it instead'],
      [{ amountPaid: 1n }, 'refund it instead'],
      [{ fulfillmentStatus: 'PARTIALLY_FULFILLED' }, 'has shipped'],
      [{ status: 'COMPLETE' }, 'complete order can’t be cancelled'],
    ];
    for (const [extra, msg] of refused) {
      setState(state(extra));
      await expect(svc.cancel('o1', ADMIN, 'x')).rejects.toThrow(msg);
    }
  });

  it('expires stale unpaid orders, skipping ones that can no longer be cancelled', async () => {
    const { svc, prisma, setState } = setup();
    prisma.order.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
    let n = 0;
    prisma.$queryRaw.mockImplementation(async () => [
      state(n++ === 0 ? {} : { paymentStatus: 'PAID' }),
    ]);
    void setState;
    expect(await svc.expireUnpaid(new Date('2026-11-14T12:00:00Z'))).toBe(1);
    expect(prisma.order.findMany.mock.calls[0][0].where.placedAt.lt).toEqual(
      new Date('2026-11-14T11:00:00Z'),
    );
  });

  it('ships remaining or chosen units and completes paid orders', async () => {
    const { svc, prisma, b, setState } = setup();
    setState(state({ status: 'PROCESSING', paymentStatus: 'PAID' }));
    const lines = [
      { id: 'i1', quantity: 2, qtyShipped: 0, qtyRefunded: 0 },
      { id: 'i2', quantity: 1, qtyShipped: 1, qtyRefunded: 0 },
    ];
    prisma.orderItem.findMany
      .mockResolvedValueOnce(lines)
      .mockResolvedValueOnce([
        { quantity: 2, qtyShipped: 2, qtyRefunded: 0 },
        { quantity: 1, qtyShipped: 1, qtyRefunded: 0 },
      ]);
    expect(
      await svc.ship('o1', { carrier: 'ups', trackingNumber: '1Z' }, ADMIN),
    ).toBe('SH-US-000007');
    expect(prisma.shipment.create.mock.calls[0][0].data.items.create).toEqual([
      { orderItemId: 'i1', quantity: 2 },
    ]);
    expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({
      fulfillmentStatus: 'FULFILLED',
      status: 'COMPLETE',
    });
    expect(b.afterNames()).toEqual(['order.shipped', 'order.completed']);

    prisma.orderItem.findMany
      .mockResolvedValueOnce(lines)
      .mockResolvedValueOnce([{ quantity: 2, qtyShipped: 1, qtyRefunded: 0 }]);
    await svc.ship(
      'o1',
      { carrier: 'ups', items: [{ orderItemId: 'i1', quantity: 1 }] },
      ADMIN,
    );
    expect(prisma.order.update.mock.calls[1][0].data).toEqual({
      fulfillmentStatus: 'PARTIALLY_FULFILLED',
      version: { increment: 1 },
    });

    prisma.orderItem.findMany.mockResolvedValue(lines);
    await expect(
      svc.ship(
        'o1',
        { carrier: 'ups', items: [{ orderItemId: 'zz', quantity: 1 }] },
        ADMIN,
      ),
    ).rejects.toThrow('not a shippable line');
    await expect(
      svc.ship(
        'o1',
        { carrier: 'ups', items: [{ orderItemId: 'i1', quantity: 3 }] },
        ADMIN,
      ),
    ).rejects.toThrow('Only 2');
    prisma.orderItem.findMany.mockResolvedValue([lines[1]]);
    await expect(svc.ship('o1', { carrier: 'ups' }, ADMIN)).rejects.toThrow(
      'Nothing left',
    );
    setState(state());
    await expect(svc.ship('o1', { carrier: 'ups' }, ADMIN)).rejects.toThrow(
      'not paid yet',
    );
    setState(state({ status: 'CANCELED' }));
    await expect(svc.ship('o1', { carrier: 'ups' }, ADMIN)).rejects.toThrow(
      'canceled order',
    );
  });

  it('delivers shipments once and adds notes', async () => {
    const { svc, prisma, b } = setup();
    prisma.shipment.findUnique.mockResolvedValue({
      orderId: 'o1',
      status: 'SHIPPED',
      number: 'SH-1',
    });
    prisma.shipment.updateMany.mockResolvedValueOnce({ count: 1 });
    await svc.deliver('sh1', ADMIN);
    await svc.deliver('sh1', ADMIN);
    expect(b.afterNames()).toEqual(['order.delivered']);
    prisma.shipment.findUnique.mockResolvedValue(null);
    await expect(svc.deliver('sh9', ADMIN)).rejects.toThrow('not found');
    await svc.addNote('o1', 'Gift wrap', true, SYSTEM_ACTOR);
    expect(prisma.orderHistory.create.mock.calls.at(-1)![0].data).toMatchObject(
      { event: 'note', isPublic: true, actorLabel: 'system' },
    );
  });
});
