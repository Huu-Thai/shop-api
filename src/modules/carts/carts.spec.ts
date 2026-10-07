import { sha256 } from '../../common/auth/api-key-format.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import type { StoreContext } from '../stores/context/store-context.js';
import type { CartRow, PricedCart } from './cart-pricer.js';
import { cartView } from './cart-view.js';
import { CartsController } from './carts.controller.js';
import { CartsService } from './carts.service.js';

const ctx = (customer?: string): StoreContext =>
  ({
    storeId: 's1',
    storeCode: 'us',
    websiteId: 'w1',
    websiteCode: 'us',
    localeCode: 'en-US',
    localeChain: ['en-US'],
    currencyCode: 'USD',
    countryCode: 'US',
    pricesIncludeTax: false,
    ...(customer ? { customer: { id: customer } } : {}),
  }) as StoreContext;

const line = (id: string, variantId: string, quantity = 1, signature = '') => ({
  id,
  variantId,
  quantity,
  options: [],
  signature,
  createdAt: new Date(),
});

const cart = (extra: Partial<CartRow> = {}): CartRow =>
  ({
    id: 'c1',
    storeId: 's1',
    customerId: null,
    status: 'ACTIVE',
    currencyCode: 'USD',
    email: null,
    couponCode: null,
    shippingAddress: null,
    billingAddress: null,
    shippingMethodId: null,
    loyaltyPoints: 0,
    version: 1,
    updatedAt: new Date(),
    items: [],
    ...extra,
  }) as CartRow;

const address = {
  firstName: 'A',
  lastName: 'B',
  countryCode: 'US',
  city: 'LA',
  line1: '1 Main',
};

function setup() {
  const prisma = fakePrisma();
  const b = fakeBus(prisma);
  prisma.cart.update.mockImplementation(async () => cart({ version: 2 }));
  const pricer = { price: vi.fn() };
  const facts = new Map<string, object>([
    [
      'v-tee',
      { productId: 'p-tee', enabled: true, type: 'SIMPLE', bundleOptions: [] },
    ],
    [
      'v-gift',
      {
        productId: 'p-gift',
        enabled: true,
        type: 'GIFT_CARD',
        bundleOptions: [],
      },
    ],
    [
      'v-off',
      { productId: 'p-off', enabled: false, type: 'SIMPLE', bundleOptions: [] },
    ],
    [
      'v-kit',
      {
        productId: 'p-kit',
        productSku: 'KIT',
        enabled: true,
        type: 'BUNDLE',
        bundleOptions: [
          {
            code: 'a',
            inputType: 'CHECKBOX',
            isRequired: true,
            selections: [
              {
                variantId: 'v-tee',
                sku: 'TEE',
                enabled: true,
                qty: 2,
                canChangeQty: false,
                isDefault: true,
              },
              {
                variantId: 'v-mug',
                sku: 'MUG',
                enabled: true,
                qty: 1,
                canChangeQty: false,
                isDefault: true,
              },
            ],
          },
        ],
      },
    ],
  ]);
  const products = {
    variantIdsBySku: vi.fn(
      async (skus: string[]) =>
        new Map(
          skus
            .filter((s) => s !== 'NOPE')
            .map((s) => [s, `v-${s.toLowerCase()}`]),
        ),
    ),
    cartLines: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.flatMap((id) => (facts.has(id) ? [[id, facts.get(id)]] : [])),
        ),
    ),
    visibleIds: vi.fn(async (_c: unknown, ids: string[]) => ids),
  };
  const stock = new Map<string, { managed: boolean; salable: number | null }>([
    ['v-tee', { managed: true, salable: 5 }],
    ['v-mug', { managed: true, salable: 0 }],
  ]);
  const inventory = { salable: vi.fn(async () => stock) };
  const loyalty = {
    redemptionTerms: vi.fn(async () => ({
      balance: 500,
      pointValue: 1n,
      currencyCode: 'USD',
      minRedeemPoints: 100,
      maxRedeemPercent: 50,
    })),
  };
  const customers = {
    address: vi.fn(async () => ({ ...address, company: null })),
  };
  const svc = new CartsService(
    prisma as never,
    b.bus,
    pricer as never,
    products as never,
    inventory as never,
    loyalty as never,
    customers as never,
  );
  return { prisma, b, svc, pricer, products, stock, loyalty, customers };
}

describe('CartsService', () => {
  it('finds carts by session or hashed token', async () => {
    const { svc, prisma } = setup();
    expect(await svc.current(ctx())).toBeNull();
    await svc.current(ctx(), 'tok');
    expect(prisma.cart.findFirst.mock.calls[0][0].where).toMatchObject({
      tokenHash: sha256('tok'),
      status: 'ACTIVE',
    });
    await svc.current(ctx('cust'));
    expect(prisma.cart.findFirst.mock.calls[1][0].where).toMatchObject({
      customerId: 'cust',
    });
    await expect(svc.require(ctx(), 'tok')).rejects.toThrow('No cart');
  });

  it('creates guest carts with a token; customers reuse their cart', async () => {
    const { svc, prisma, b } = setup();
    prisma.cart.create.mockResolvedValue(cart());
    const guest = await svc.create(ctx());
    expect(guest.token).toMatch(/^[\w-]{43}$/);
    expect(prisma.cart.create.mock.calls[0][0].data.tokenHash).toBe(
      sha256(guest.token!),
    );
    expect(b.afterNames()).toEqual(['cart.created']);
    const existing = cart({ customerId: 'cust' });
    prisma.cart.findFirst.mockResolvedValueOnce(existing);
    expect(await svc.create(ctx('cust'))).toEqual({ cart: existing });
    const fresh = await svc.create(ctx('cust'));
    expect(fresh.token).toBeUndefined();
  });

  it('adds items: merges same lines, checks visibility, options and stock', async () => {
    const { svc, prisma, stock, b } = setup();
    prisma.cart.findFirst.mockResolvedValue(
      cart({ items: [line('i1', 'v-tee', 2)] }),
    );
    await svc.addItem(ctx(), 'tok', { sku: 'TEE', quantity: 3 });
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { quantity: { increment: 3 } },
    });
    expect(b.afterNames()).toEqual(['cart.updated']);
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'TEE', quantity: 4 }),
    ).rejects.toThrow('Only 5 available');
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'NOPE', quantity: 1 }),
    ).rejects.toThrow('Unknown SKU');
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'OFF', quantity: 1 }),
    ).rejects.toThrow('not sold');
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'GIFT', quantity: 1 }),
    ).rejects.toThrow('Gift cards');
    await expect(
      svc.addItem(ctx(), 'tok', {
        sku: 'TEE',
        quantity: 1,
        options: [{ option: 'a', sku: 'x' }],
      }),
    ).rejects.toThrow('no options');
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'KIT', quantity: 1 }),
    ).rejects.toThrow('Out of stock');
    stock.set('v-mug', { managed: true, salable: 9 });
    await svc.addItem(ctx(), 'tok', { sku: 'KIT', quantity: 2 });
    expect(prisma.cartItem.create.mock.calls[0][0].data).toMatchObject({
      variantId: 'v-kit',
      quantity: 2,
      signature: 'a:MUG:1|a:TEE:2',
    });
    prisma.cart.findFirst.mockResolvedValue(
      cart({
        items: Array.from({ length: 100 }, (_, n) => line(`i${n}`, `v${n}`)),
      }),
    );
    await expect(
      svc.addItem(ctx(), 'tok', { sku: 'TEE', quantity: 1 }),
    ).rejects.toThrow('at most 100');
  });

  it('a customer’s first change creates their cart', async () => {
    const { svc, prisma } = setup();
    prisma.cart.findFirst.mockResolvedValue(null);
    prisma.cart.create.mockResolvedValue(cart({ customerId: 'cust' }));
    await svc.addItem(ctx('cust'), undefined, { sku: 'TEE', quantity: 1 });
    expect(prisma.cart.create).toHaveBeenCalled();
    expect(prisma.cartItem.create).toHaveBeenCalled();
  });

  it('updates and removes lines', async () => {
    const { svc, prisma, stock } = setup();
    prisma.cart.findFirst.mockResolvedValue(
      cart({ items: [line('i1', 'v-tee', 2), line('i2', 'v-kit', 1, 'sig')] }),
    );
    await svc.updateItem(ctx(), 'tok', 'i1', 1);
    await svc.updateItem(ctx(), 'tok', 'i1', 5);
    await expect(svc.updateItem(ctx(), 'tok', 'i1', 6)).rejects.toThrow(
      'Only 5',
    );
    await expect(svc.updateItem(ctx(), 'tok', 'i2', 2)).rejects.toThrow(
      'Out of stock',
    );
    stock.set('v-mug', { managed: false, salable: null });
    await svc.updateItem(ctx(), 'tok', 'i2', 2);
    await expect(svc.updateItem(ctx(), 'tok', 'zz', 1)).rejects.toThrow(
      'not found',
    );
    await svc.removeItem(ctx(), 'tok', 'i1');
    expect(prisma.cartItem.delete).toHaveBeenCalledWith({
      where: { id: 'i1' },
    });
    await expect(svc.removeItem(ctx(), 'tok', 'zz')).rejects.toThrow(
      'not found',
    );
  });

  it('accepts only coupons that apply now', async () => {
    const { svc, prisma, pricer } = setup();
    prisma.cart.findFirst.mockResolvedValue(cart());
    pricer.price.mockResolvedValueOnce({
      evaluation: { coupon: { code: 'SAVE10', status: 'APPLIED' } },
    });
    await svc.setCoupon(ctx(), 'tok', 'save10');
    expect(prisma.cart.update.mock.calls[0][0].data).toEqual({
      couponCode: 'SAVE10',
    });
    pricer.price.mockResolvedValueOnce({
      evaluation: { coupon: { status: 'EXPIRED', message: 'Expired' } },
    });
    await expect(svc.setCoupon(ctx(), 'tok', 'old')).rejects.toThrow('Expired');
    pricer.price.mockResolvedValueOnce({ evaluation: { coupon: null } });
    await expect(svc.setCoupon(ctx(), 'tok', 'x')).rejects.toThrow('not valid');
    await svc.setCoupon(ctx(), 'tok', null);
    await svc.setEmail(ctx(), 'tok', 'a@b.co');
    expect(prisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { email: 'a@b.co' },
    });
  });

  it('sets addresses from fields or the address book', async () => {
    const { svc, prisma, customers } = setup();
    prisma.cart.findFirst.mockResolvedValue(cart());
    await svc.setAddresses(ctx(), 'tok', { shipping: address });
    expect(
      prisma.cart.update.mock.calls[0][0].data.shippingAddress,
    ).toMatchObject({ ...address, company: null, line2: null });
    await svc.setAddresses(ctx('cust'), undefined, {
      billing: { addressId: 'a1' },
    });
    expect(customers.address).toHaveBeenCalledWith('cust', 'a1');
    await expect(svc.setAddresses(ctx(), 'tok', {})).rejects.toThrow(
      'Send a shipping',
    );
    await expect(
      svc.setAddresses(ctx(), 'tok', { billing: { addressId: 'a1' } }),
    ).rejects.toThrow('Sign in');
    customers.address.mockResolvedValueOnce(null as never);
    await expect(
      svc.setAddresses(ctx('cust'), undefined, {
        shipping: { addressId: 'a9' },
      }),
    ).rejects.toThrow('not found');
    await expect(
      svc.setAddresses(ctx(), 'tok', { shipping: { firstName: 'A' } }),
    ).rejects.toMatchObject({
      response: {
        message: [
          'shipping.lastName is required',
          'shipping.countryCode is required',
          'shipping.city is required',
          'shipping.line1 is required',
        ],
      },
    });
  });

  it('chooses a shipping method the cart can use', async () => {
    const { svc, prisma, pricer } = setup();
    prisma.cart.findFirst.mockResolvedValue(cart());
    pricer.price.mockResolvedValue({
      requiresShipping: true,
      shippingOptions: [{ id: 'm1', code: 'std' }],
    });
    await svc.setShippingMethod(ctx(), 'tok', 'std');
    expect(prisma.cart.update.mock.calls[0][0].data).toEqual({
      shippingMethodId: 'm1',
    });
    await expect(svc.setShippingMethod(ctx(), 'tok', 'air')).rejects.toThrow(
      'not available',
    );
    pricer.price.mockResolvedValue({
      requiresShipping: false,
      shippingOptions: [],
    });
    await expect(svc.setShippingMethod(ctx(), 'tok', 'std')).rejects.toThrow(
      'nothing to ship',
    );
  });

  it('checks points against the customer’s terms', async () => {
    const { svc, prisma, loyalty } = setup();
    prisma.cart.findFirst.mockResolvedValue(cart());
    await svc.setLoyaltyPoints(ctx('cust'), undefined, 200);
    await svc.setLoyaltyPoints(ctx(), 'tok', 0);
    await expect(svc.setLoyaltyPoints(ctx(), 'tok', 200)).rejects.toThrow(
      'Sign in',
    );
    await expect(
      svc.setLoyaltyPoints(ctx('cust'), undefined, 50),
    ).rejects.toThrow('at least 100');
    await expect(
      svc.setLoyaltyPoints(ctx('cust'), undefined, 900),
    ).rejects.toThrow('Only 500');
    loyalty.redemptionTerms.mockResolvedValueOnce({
      balance: 500,
      pointValue: 1n,
      currencyCode: 'VND',
      minRedeemPoints: 0,
      maxRedeemPercent: 100,
    });
    await expect(
      svc.setLoyaltyPoints(ctx('cust'), undefined, 200),
    ).rejects.toThrow('VND orders only');
    loyalty.redemptionTerms.mockResolvedValueOnce(null as never);
    await expect(
      svc.setLoyaltyPoints(ctx('cust'), undefined, 200),
    ).rejects.toThrow('no points');
  });

  it('merges a guest cart into the customer’s', async () => {
    const { svc, prisma, b } = setup();
    await expect(svc.merge(ctx(), 'tok')).rejects.toThrow('Sign in');
    const guest = cart({
      id: 'g1',
      email: 'g@x.co',
      couponCode: 'SAVE',
      shippingAddress: address as never,
      items: [line('g-a', 'v-tee', 2), line('g-b', 'v-mug', 1)],
    });
    const mine = cart({
      id: 'c1',
      customerId: 'cust',
      items: [line('i1', 'v-tee', 1)],
    });
    prisma.cart.findFirst
      .mockResolvedValueOnce(guest)
      .mockResolvedValueOnce(mine);
    await svc.merge(ctx('cust'), 'tok');
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { quantity: { increment: 2 } },
    });
    expect(prisma.cartItem.create.mock.calls[0][0].data).toMatchObject({
      cartId: 'c1',
      variantId: 'v-mug',
    });
    expect(prisma.cart.update.mock.calls[0][0].data).toMatchObject({
      couponCode: 'SAVE',
      email: 'g@x.co',
      shippingAddress: address,
    });
    expect(prisma.cart.update.mock.calls[1][0]).toEqual({
      where: { id: 'g1' },
      data: { status: 'MERGED' },
    });
    expect(b.afterNames()).toEqual(['cart.merged', 'cart.updated']);
    prisma.cart.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mine);
    expect(await svc.merge(ctx('cust'), 'gone')).toBe(mine);
  });

  it('converts once, purges old carts and prices', async () => {
    const { svc, prisma, b, pricer } = setup();
    prisma.cart.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await svc.convert('c1', 'o1');
    await svc.convert('c1', 'o1');
    expect(b.afterNames()).toEqual(['cart.converted']);
    prisma.cart.deleteMany.mockResolvedValue({ count: 4 });
    expect(await svc.purge(new Date('2026-11-14'))).toBe(4);
    expect(
      prisma.cart.deleteMany.mock.calls[0][0].where.OR[0].updatedAt.lt,
    ).toEqual(new Date('2026-10-15'));
    pricer.price.mockResolvedValue('priced');
    expect(await svc.price(cart(), ctx())).toBe('priced');
  });
});

const priced = (extra: Partial<PricedCart> = {}): PricedCart =>
  ({
    cart: cart({ email: 'a@b.co', shippingAddress: address as never }),
    ctx: ctx(),
    lines: [
      {
        itemId: 'i1',
        sku: 'KIT',
        name: 'Kit',
        productId: 'p',
        variantId: 'v',
        type: 'BUNDLE',
        quantity: 2,
        attributes: {},
        options: [{ option: 'a', sku: 'TEE' }],
        unitPrice: 100n,
        rowTotal: 200n,
        discount: 0n,
        taxAmount: 20n,
        available: true,
        message: null,
      },
    ],
    evaluation: {
      result: {
        applied: [{ label: 'Sale', discount: 10n, freeShipping: true }],
        freeShipping: true,
      },
      coupon: { code: 'X', status: 'APPLIED', message: 'ok' },
    },
    shippingOptions: [
      { code: 'std', carrier: 'ups', name: 'Std', amount: 800n },
    ],
    shipping: {
      code: 'std',
      carrier: 'ups',
      name: 'Std',
      description: null,
      amount: 800n,
    },
    shippingAmount: 800n,
    shippingDiscount: 800n,
    subtotal: 200n,
    discountTotal: 10n,
    taxTotal: 20n,
    grandTotal: 210n,
    loyaltyPoints: 0,
    loyaltyAmount: 0n,
    amountDue: 210n,
    requiresShipping: true,
    missing: [],
    warnings: [],
    format: (a: bigint) => `$${a}`,
    ...extra,
  }) as never;

describe('cartView', () => {
  it('shapes the priced cart for the storefront', () => {
    const v = cartView(priced(), 'tok');
    expect(v).toMatchObject({
      id: 'c1',
      token: 'tok',
      itemCount: 2,
      coupon: { code: 'X' },
    });
    expect(v.items[0].options).toEqual([
      { option: 'a', sku: 'TEE', quantity: 1 },
    ]);
    expect(v.billingAddress).toEqual(v.shippingAddress);
    expect(v.shippingMethod?.price).toEqual({ amount: 0, formatted: '$0' });
    const bare = cartView(
      priced({
        shipping: null,
        evaluation: {
          result: { applied: [], freeShipping: false },
          coupon: null,
        } as never,
        cart: cart(),
      }),
    );
    expect([
      bare.token,
      bare.coupon,
      bare.shippingMethod,
      bare.shippingAddress,
    ]).toEqual([undefined, null, null, null]);
  });
});

describe('CartsController', () => {
  it('returns cart views from every route', async () => {
    const p = priced();
    const svc = stubService({ ...p, cart: p.cart });
    svc.create.mockResolvedValue({ cart: p.cart, token: 't' });
    const ctrl = new CartsController(svc as never);
    expect(await exerciseController(ctrl)).toEqual({ ok: 14, failed: 0 });
    expect(await ctrl.shippingMethods(ctx())).toEqual([
      {
        code: 'std',
        carrier: 'ups',
        name: 'Std',
        price: { amount: 0, formatted: '$0' },
      },
    ]);
  });
});
