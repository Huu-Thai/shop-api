import { NotFoundException } from '@nestjs/common';
import { sha256 } from '../../common/auth/api-key-format.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { fakeStores } from '../../testing/stores.js';
import type { StoreContext } from '../stores/context/store-context.js';
import {
  OrdersAdminController,
  StorefrontOrdersController,
} from './orders.controllers.js';
import { OrdersListener } from './orders.listener.js';
import { OrdersQuery } from './orders.query.js';

const ctx = (customer?: string): StoreContext =>
  ({
    storeId: 's1',
    localeCode: 'en-US',
    ...(customer ? { customer: { id: customer, email: 'c@x.co' } } : {}),
  }) as StoreContext;

const item = (id: string, extra: object = {}) => ({
  id,
  parentItemId: null,
  sku: id.toUpperCase(),
  name: id,
  productType: 'SIMPLE',
  quantity: 2,
  unitPrice: 1000n,
  rowTotal: 2000n,
  discount: 200n,
  taxAmount: 180n,
  taxRate: new Prisma.Decimal('0.1'),
  qtyShipped: 0,
  qtyRefunded: 0,
  options: null,
  reservationGroupId: `g-${id}`,
  ...extra,
});

const viewRow = () => ({
  id: 'o1',
  number: 'US-000001',
  storeId: 's1',
  customerId: 'cust',
  customerGroupCode: 'general',
  status: 'PROCESSING',
  paymentStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  email: 'c@x.co',
  currencyCode: 'USD',
  localeCode: 'en-US',
  placedAt: new Date(),
  paidAt: new Date(),
  canceledAt: null,
  pricesIncludeTax: false,
  subtotal: 4000n,
  discountTotal: 400n,
  shippingTotal: 800n,
  taxTotal: 360n,
  grandTotal: 4760n,
  loyaltyPoints: 0,
  loyaltyAmount: 0n,
  amountDue: 4760n,
  amountPaid: 4760n,
  amountRefunded: 0n,
  shippingMethodName: 'Standard',
  couponCode: null,
  discounts: [{ label: 'Sale', discount: '400' }],
  items: [
    item('a'),
    item('kit'),
    item('c', { parentItemId: 'kit', unitPrice: 0n }),
  ],
  addresses: [
    {
      type: 'SHIPPING',
      firstName: 'A',
      lastName: 'B',
      company: null,
      phone: null,
      countryCode: 'US',
      regionCode: null,
      city: 'LA',
      postcode: null,
      line1: '1',
      line2: null,
    },
  ],
  shipments: [
    {
      id: 'sh1',
      number: 'SH-1',
      carrier: 'ups',
      trackingNumber: null,
      trackingUrl: null,
      status: 'SHIPPED',
      shippedAt: new Date(),
      deliveredAt: null,
      items: [{ orderItemId: 'a', quantity: 2, orderItem: { sku: 'A' } }],
    },
  ],
  invoices: [{ number: 'INV-1', grandTotal: 4760n, issuedAt: new Date() }],
  creditMemos: [{ number: 'CM-1', amount: 100n, issuedAt: new Date() }],
  history: [
    {
      event: 'placed',
      message: 'Placed',
      createdAt: new Date(),
      actorLabel: 'c',
      isPublic: true,
    },
    {
      event: 'note',
      message: 'Fraud check',
      createdAt: new Date(),
      actorLabel: 'staff',
      isPublic: false,
    },
  ],
});

function query() {
  const prisma = fakePrisma();
  return { prisma, q: new OrdersQuery(prisma as never, fakeStores() as never) };
}

describe('OrdersQuery', () => {
  it('lets the owner or the token holder see an order, nobody else', async () => {
    const { prisma, q } = query();
    prisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      customerId: 'cust',
      accessTokenHash: sha256('tok'),
    });
    expect(await q.accessible(ctx('cust'), 'US-1')).toBe('o1');
    expect(await q.accessible(ctx(), 'US-1', 'tok')).toBe('o1');
    await expect(q.accessible(ctx(), 'US-1', 'bad')).rejects.toThrow(
      'not found',
    );
    await expect(q.accessible(ctx('other'), 'US-1')).rejects.toThrow(
      'not found',
    );
    prisma.order.findFirst.mockResolvedValue(null);
    await expect(q.accessible(ctx(), 'US-1', 'tok')).rejects.toThrow(
      'not found',
    );
  });

  it('builds staff and storefront views', async () => {
    const { prisma, q } = query();
    prisma.order.findUnique.mockResolvedValue(viewRow());
    const staff = await q.view('o1', true);
    expect(
      staff.items.map((i) => [i.sku, i.children.map((c) => c.sku)]),
    ).toEqual([
      ['A', []],
      ['KIT', ['C']],
    ]);
    expect(staff.items[0]).toMatchObject({ taxRate: '0.1000', options: {} });
    expect(staff.totals.grandTotal).toEqual({
      amount: 4760,
      formatted: '$47.60',
    });
    expect(staff.billingAddress).toBeNull();
    expect(staff.shippingAddress).toMatchObject({ city: 'LA' });
    expect(staff.promotions[0].discount.amount).toBe(400);
    expect(staff.history).toHaveLength(2);
    const pub = await q.publicView('o1');
    expect(pub).not.toHaveProperty('customerId');
    expect(pub.history).toEqual([
      { event: 'placed', message: 'Placed', createdAt: expect.any(Date) },
    ]);
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(q.view('x')).rejects.toThrow('not found');
  });

  it('lists orders for staff and for a customer', async () => {
    const { prisma, q } = query();
    const row = {
      id: 'o1',
      number: 'US-1',
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      grandTotal: 4760n,
      currencyCode: 'USD',
      placedAt: new Date(),
      email: 'c@x.co',
      storeId: 's1',
      items: [{ quantity: 2 }, { quantity: 1 }],
    };
    prisma.order.findMany.mockResolvedValue([row]);
    prisma.order.count.mockResolvedValue(1);
    const page = { skip: 0, limit: 20, page: 1, order: 'desc' } as never;
    const staff = await q.list({
      ...(page as object),
      search: 'us-1',
    } as never);
    expect(staff.data[0]).toMatchObject({
      itemCount: 3,
      email: 'c@x.co',
      storeId: 's1',
    });
    expect(prisma.order.findMany.mock.calls[0][0].where.OR[0]).toEqual({
      number: { contains: 'US-1' },
    });
    await q.list(page);
    expect(prisma.order.findMany.mock.calls[1][0].where.OR).toBeUndefined();
    const mine = await q.forCustomer(ctx('cust'), 'cust', page);
    expect(mine.data[0]).not.toHaveProperty('email');
  });

  it('gives payments and listeners the facts they need', async () => {
    const { prisma, q } = query();
    prisma.order.findUnique
      .mockResolvedValueOnce({ id: 'o1', addresses: [{ countryCode: 'VN' }] })
      .mockResolvedValueOnce({ id: 'o1', addresses: [] });
    expect((await q.paymentFacts('o1')).billingCountry).toBe('VN');
    expect((await q.paymentFacts('o1')).billingCountry).toBeNull();
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'o1',
      pricesIncludeTax: true,
      items: [item('a'), item('c', { parentItemId: 'a' })],
    });
    expect((await q.effects('o1')).eligible).toBe(2000n - 200n - 180n);
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'o1',
      pricesIncludeTax: false,
      items: [item('a')],
    });
    expect((await q.effects('o1')).eligible).toBe(1800n);
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(q.paymentFacts('o1')).rejects.toThrow('not found');
    await expect(q.effects('o1')).rejects.toThrow('not found');
  });
});

describe('OrdersListener', () => {
  function setup(effects: object = {}) {
    const orders = {
      recordPayment: vi.fn<AnyFn>(),
      accept: vi.fn<AnyFn>(),
      recordRefund: vi.fn<AnyFn>(),
    };
    const q = {
      effects: vi.fn<AnyFn>(async () => ({
        id: 'o1',
        number: 'US-1',
        customerId: 'cust',
        currencyCode: 'USD',
        loyaltyPoints: 100,
        amountPaid: 5000n,
        eligible: 4000n,
        items: [
          { reservationGroupId: 'g-active', quantity: 1, sku: 'A' },
          { reservationGroupId: 'g-sold', quantity: 2, sku: 'B' },
          { reservationGroupId: 'g-expired', quantity: 1, sku: 'C' },
          { reservationGroupId: 'g-gone', quantity: 1, sku: 'D' },
          { reservationGroupId: null, quantity: 1, sku: 'E' },
        ],
        ...effects,
      })),
    };
    const carts = { convert: vi.fn<AnyFn>() };
    const statuses: Record<string, string> = {
      'g-active': 'ACTIVE',
      'g-sold': 'CONVERTED',
      'g-expired': 'EXPIRED',
    };
    const reservations = {
      get: vi.fn<AnyFn>(async (g: string) => {
        if (!statuses[g]) throw new NotFoundException();
        return { status: statuses[g] };
      }),
      convert: vi.fn<AnyFn>(),
      release: vi.fn<AnyFn>(),
      returnStock: vi.fn<AnyFn>(),
    };
    const redemptions = { release: vi.fn<AnyFn>(async () => undefined) };
    const loyalty = {
      earn: vi.fn<AnyFn>(),
      reverse: vi.fn<AnyFn>(async () => undefined),
    };
    const loyaltyQuery = {
      redemptionTerms: vi.fn<AnyFn>(async () => ({ currencyCode: 'USD' })),
    };
    const l = new OrdersListener(
      orders as never,
      q as never,
      carts as never,
      reservations as never,
      redemptions as never,
      loyalty as never,
      loyaltyQuery as never,
    );
    return {
      l,
      orders,
      q,
      carts,
      reservations,
      redemptions,
      loyalty,
      loyaltyQuery,
    };
  }
  const ev = (data: object) => ({ data }) as never;

  it('applies payment events to the order', async () => {
    const { l, orders } = setup();
    await l.onCaptured(
      ev({ orderId: 'o1', amount: '100', totalCaptured: '300' }),
    );
    await l.onCaptured(ev({ orderId: 'o1', amount: '100' }));
    expect(orders.recordPayment.mock.calls).toEqual([
      ['o1', 300n],
      ['o1', 100n],
    ]);
    await l.onAccepted(ev({ orderId: 'o1' }));
    expect(orders.accept).toHaveBeenCalledWith('o1');
    await l.onRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r1',
        amount: '10',
        totalRefunded: '10',
        items: [],
        restock: false,
      }),
    );
    expect(orders.recordRefund.mock.calls[0][0]).toMatchObject({
      totalCaptured: 10n,
    });
  });

  it('converts the cart and sells reserved stock on payment, earning points', async () => {
    const { l, carts, reservations, loyalty, loyaltyQuery } = setup();
    await l.onPlaced(ev({ orderId: 'o1', cartId: 'c1' }));
    await l.onPlaced(ev({ orderId: 'o1' }));
    expect(carts.convert).toHaveBeenCalledTimes(1);
    await l.onPaid(ev({ orderId: 'o1' }));
    expect(reservations.convert.mock.calls).toEqual([
      ['g-active', 'ORDER:US-1'],
    ]);
    expect(loyalty.earn.mock.calls[0][1]).toMatchObject({ amount: 4000 });
    loyaltyQuery.redemptionTerms.mockResolvedValueOnce({ currencyCode: 'VND' });
    await l.onPaid(ev({ orderId: 'o1' }));
    expect(loyalty.earn).toHaveBeenCalledTimes(1);
    await l.onOrderAccepted(ev({ orderId: 'o1' }));
    expect(reservations.convert).toHaveBeenCalledTimes(3);
  });

  it('does not earn points for guests or unpaid orders', async () => {
    const guest = setup({ customerId: null });
    await guest.l.onPaid(ev({ orderId: 'o1' }));
    const unpaid = setup({ amountPaid: 0n, eligible: 9000n });
    await unpaid.l.onPaid(ev({ orderId: 'o1' }));
    expect(guest.loyalty.earn).not.toHaveBeenCalled();
    expect(unpaid.loyalty.earn).not.toHaveBeenCalled();
  });

  it('gives everything back on cancellation', async () => {
    const { l, reservations, redemptions, loyalty } = setup();
    await l.onCanceled(ev({ orderId: 'o1' }));
    expect(reservations.release).toHaveBeenCalledWith('g-active');
    expect(reservations.returnStock).toHaveBeenCalledWith(
      'g-sold',
      2,
      'CANCEL:US-1',
    );
    expect(redemptions.release).toHaveBeenCalled();
    expect(loyalty.reverse.mock.calls[0][1]).toEqual({
      orderRef: 'o1',
      restoreRedeemed: true,
    });
    redemptions.release.mockRejectedValueOnce(new NotFoundException());
    await l.onCanceled(ev({ orderId: 'o1' }));
    redemptions.release.mockRejectedValueOnce(new Error('db'));
    await expect(l.onCanceled(ev({ orderId: 'o1' }))).rejects.toThrow('db');
    const noPoints = setup({ loyaltyPoints: 0 });
    await noPoints.l.onCanceled(ev({ orderId: 'o1' }));
    expect(noPoints.loyalty.reverse).not.toHaveBeenCalled();
  });

  it('restocks and takes points back on refunds', async () => {
    const { l, reservations, loyalty } = setup();
    await l.onOrderRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r1',
        amount: '2500',
        full: false,
        restock: [{ reservationGroupId: 'g1', quantity: 1 }],
      }),
    );
    expect(reservations.returnStock).toHaveBeenCalledWith('g1', 1, 'REFUND:r1');
    expect(loyalty.reverse.mock.calls[0][1]).toEqual({
      orderRef: 'o1',
      amount: 2000,
      restoreRedeemed: false,
    });
    await l.onOrderRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r2',
        amount: '1',
        full: false,
        restock: [],
      }),
    );
    expect(loyalty.reverse.mock.calls[1][1].amount).toBe(1);
    await l.onOrderRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r3',
        amount: '5000',
        full: true,
        restock: [],
      }),
    );
    expect(loyalty.reverse.mock.calls[2][1]).toEqual({
      orderRef: 'o1',
      restoreRedeemed: true,
    });
    const unpaid = setup({ amountPaid: 0n });
    await unpaid.l.onOrderRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r',
        amount: '5',
        full: false,
        restock: [],
      }),
    );
    expect(unpaid.loyalty.reverse.mock.calls[0][1].amount).toBe(1);
    const guest = setup({ customerId: null });
    await guest.l.onOrderRefunded(
      ev({
        orderId: 'o1',
        refundId: 'r',
        amount: '5',
        full: false,
        restock: [],
      }),
    );
    expect(guest.loyalty.reverse).not.toHaveBeenCalled();
  });
});

describe('order controllers', () => {
  it('storefront: places, lists, reads and cancels', async () => {
    const orders = stubService();
    orders.place.mockResolvedValue({ orderId: 'o1', accessToken: 'tok' });
    const query = stubService({
      id: 'o1',
      status: 'PENDING_PAYMENT',
      email: 'g@x.co',
    });
    const c = new StorefrontOrdersController(orders as never, query as never);
    expect(await c.place(ctx(), 'key-12345')).toMatchObject({
      accessToken: 'tok',
    });
    expect(await c.place(ctx('cust'), undefined as never)).not.toHaveProperty(
      'accessToken',
    );
    expect(orders.place.mock.calls[1][2]).toBe('');
    await c.cancel(ctx(), 'US-1', {}, 'tok');
    expect(orders.cancel.mock.calls[0].slice(1)).toEqual([
      { type: 'system', id: null, label: 'guest g@x.co' },
      'Cancelled by the shopper',
    ]);
    await c.cancel(ctx('cust'), 'US-1', { reason: 'Changed my mind' });
    expect(orders.cancel.mock.calls[1].slice(1)).toEqual([
      { type: 'customer', id: 'cust', label: 'c@x.co' },
      'Cancelled by the shopper: Changed my mind',
    ]);
    query.view.mockResolvedValue({ status: 'PROCESSING' });
    await expect(c.cancel(ctx(), 'US-1', {}, 'tok')).rejects.toThrow(
      'contact us',
    );
    expect(
      await exerciseController(
        new StorefrontOrdersController(
          stubService({ status: 'PENDING_PAYMENT' }) as never,
          stubService({ status: 'PENDING_PAYMENT' }) as never,
        ),
      ),
    ).toMatchObject({ failed: 0 });
  });

  it('admin: delegates', async () => {
    const orders = stubService();
    const c = new OrdersAdminController(
      orders as never,
      stubService() as never,
    );
    expect(await exerciseController(c)).toEqual({ ok: 6, failed: 0 });
    await c.cancel('o1', {}, ROOT);
    expect(orders.cancel.mock.calls.at(-1)![2]).toBe('Cancelled by staff');
    await c.note('o1', { message: 'm' }, ROOT);
    expect(orders.addNote.mock.calls.at(-1)![2]).toBe(false);
  });
});
