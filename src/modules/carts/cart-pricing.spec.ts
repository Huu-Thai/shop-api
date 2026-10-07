import { fakePrisma } from '../../testing/fake-prisma.js';
import { fakeStores, storeSnap } from '../../testing/stores.js';
import type { CartLineFacts } from '../products/products.query.js';
import { choicesSignature, resolveBundle, unitPriceFor } from './cart-math.js';
import { CartPricer, type CartRow } from './cart-pricer.js';

const sel = (sku: string, extra = {}) => ({
  variantId: `v-${sku}`,
  sku,
  enabled: true,
  qty: 1,
  canChangeQty: false,
  isDefault: false,
  ...extra,
});

const kit = {
  productSku: 'KIT',
  bundleOptions: [
    {
      code: 'shirt',
      inputType: 'RADIO',
      isRequired: true,
      selections: [sel('TEE-S', { isDefault: true }), sel('TEE-M')],
    },
    {
      code: 'extras',
      inputType: 'CHECKBOX',
      isRequired: false,
      selections: [
        sel('MUG', { canChangeQty: true }),
        sel('PIN', { enabled: false }),
      ],
    },
    {
      code: 'sticker',
      inputType: 'SELECT',
      isRequired: false,
      selections: [sel('STK')],
    },
  ],
};

describe('cart math', () => {
  it('resolves bundle choices with defaults and quantities', () => {
    expect(resolveBundle(kit, [])).toEqual([
      { option: 'shirt', variantId: 'v-TEE-S', sku: 'TEE-S', quantity: 1 },
    ]);
    const out = resolveBundle(kit, [
      { option: 'shirt', sku: 'TEE-M' },
      { option: 'extras', sku: 'MUG', quantity: 3 },
    ]);
    expect(out.map((c) => `${c.sku}x${c.quantity}`)).toEqual([
      'TEE-Mx1',
      'MUGx3',
    ]);
    expect(choicesSignature(out)).toBe('extras:MUG:3|shirt:TEE-M:1');
  });

  it('rejects invalid choices', () => {
    const bad: [object[], string][] = [
      [[{ option: 'nope', sku: 'X' }], 'has no option'],
      [
        [
          { option: 'shirt', sku: 'TEE-S' },
          { option: 'shirt', sku: 'TEE-M' },
        ],
        'Choose one item',
      ],
      [[{ option: 'extras', sku: 'PIN' }], 'is not a choice'],
      [
        [
          { option: 'extras', sku: 'MUG' },
          { option: 'extras', sku: 'MUG' },
        ],
        'chosen twice',
      ],
      [[{ option: 'shirt', sku: 'TEE-S', quantity: 2 }], 'is fixed at 1'],
    ];
    for (const [choices, msg] of bad)
      expect(() => resolveBundle(kit, choices as never)).toThrow(msg);
    const required = {
      productSku: 'K',
      bundleOptions: [{ ...kit.bundleOptions[0], selections: [sel('A')] }],
    };
    expect(() => resolveBundle(required, [])).toThrow(
      'Choose an item for "shirt"',
    );
    const optional = { productSku: 'K', bundleOptions: [kit.bundleOptions[2]] };
    expect(() => resolveBundle(optional, [])).toThrow('Choose the items of K');
  });

  it('picks the best tier the quantity reaches', () => {
    const p = {
      amount: 2500,
      tiers: [
        { minQty: 3, amount: 2200 },
        { minQty: 10, amount: 2000 },
        { minQty: 5, amount: 2600 },
      ],
    };
    expect(unitPriceFor(p, 1)).toBe(2500);
    expect(unitPriceFor(p, 5)).toBe(2200);
    expect(unitPriceFor(p, 12)).toBe(2000);
  });
});

const facts = (
  sku: string,
  extra: Partial<CartLineFacts> = {},
): CartLineFacts => ({
  variantId: `v-${sku}`,
  sku,
  enabled: true,
  optionValues: {},
  productId: `p-${sku}`,
  productSku: sku,
  type: 'SIMPLE',
  taxClassId: 'tc-goods',
  categoryIds: ['c1'],
  bundleOptions: [],
  ...extra,
});

const item = (sku: string, quantity = 1, options: object[] = []) => ({
  id: `i-${sku}`,
  variantId: `v-${sku}`,
  quantity,
  options,
  signature: '',
  createdAt: new Date(),
});

const address = {
  firstName: 'A',
  lastName: 'B',
  countryCode: 'US',
  regionCode: 'CA',
  city: 'LA',
  postcode: '90001',
  line1: '1 Main',
};

const cartRow = (extra: Partial<CartRow> = {}): CartRow =>
  ({
    id: 'c1',
    storeId: 's1',
    customerId: null,
    status: 'ACTIVE',
    currencyCode: 'USD',
    email: 'a@b.co',
    couponCode: null,
    shippingAddress: address,
    billingAddress: null,
    shippingMethodId: 'ship-std',
    loyaltyPoints: 0,
    version: 1,
    updatedAt: new Date(),
    items: [],
    ...extra,
  }) as CartRow;

function setup(opts: { pricesIncludeTax?: boolean } = {}) {
  const prisma = fakePrisma();
  const stores = fakeStores(
    storeSnap({ pricesIncludeTax: opts.pricesIncludeTax ?? false }),
  );
  const catalog = new Map<string, CartLineFacts>([
    ['v-TEE', facts('TEE', { optionValues: { size: 'M' } })],
    ['v-MUG', facts('MUG')],
    ['v-EBOOK', facts('EBOOK', { type: 'VIRTUAL' })],
    ['v-GIFT', facts('GIFT', { type: 'GIFT_CARD' })],
    ['v-OFF', facts('OFF', { enabled: false })],
    ['v-HIDDEN', facts('HIDDEN')],
    ['v-NOPRICE', facts('NOPRICE')],
    ['v-SOLDOUT', facts('SOLDOUT')],
    ['v-FEW', facts('FEW')],
    [
      'v-KIT',
      facts('KIT', {
        type: 'BUNDLE',
        bundleOptions: [
          {
            code: 'a',
            inputType: 'CHECKBOX',
            isRequired: true,
            selections: [
              sel('TEE', { isDefault: true }),
              sel('MUG', { canChangeQty: true }),
              sel('NOPRICE'),
              sel('SOLDOUT'),
            ],
          },
        ],
      }),
    ],
  ]);
  const products = {
    cartLines: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.flatMap((id) =>
            catalog.has(id) ? [[id, catalog.get(id)!]] : [],
          ),
        ),
    ),
    visibleIds: vi.fn(async (_ctx: unknown, ids: string[]) =>
      ids.filter((id) => id !== 'p-HIDDEN'),
    ),
    summaries: vi.fn(async (_ctx: unknown, ids: string[]) =>
      ids.map((id) => ({ id, name: `Name ${id}` })),
    ),
  };
  const pricing = {
    prices: vi.fn(
      async (_ctx: unknown, ids: string[]) =>
        new Map(
          ids
            .filter((id) => id !== 'v-NOPRICE')
            .map((id) => [
              id,
              {
                amount: id === 'v-MUG' ? 1000 : 2500,
                tiers: [{ minQty: 3, amount: 2000 }],
              },
            ]),
        ),
    ),
  };
  const inventory = {
    salable: vi.fn(
      async () =>
        new Map([
          ['v-TEE', { managed: true, salable: 100 }],
          ['v-SOLDOUT', { managed: true, salable: 0 }],
          ['v-FEW', { managed: true, salable: 1 }],
          ['v-MUG', { managed: false, salable: null }],
        ]),
    ),
  };
  const shipping = {
    options: vi.fn(async () => [
      {
        id: 'ship-std',
        code: 'std',
        carrier: 'ups',
        name: 'Std',
        description: null,
        amount: 800n,
        taxClassId: 'tc-ship',
      },
      {
        id: 'ship-free',
        code: 'free',
        carrier: 'ups',
        name: 'Free',
        description: null,
        amount: 0n,
        taxClassId: null,
      },
    ]),
  };
  const redemptions = {
    evaluateLines: vi.fn(async (input: { lines: { key: string }[] }) => ({
      result: {
        lines: input.lines.map((l, n) => ({
          key: l.key,
          discount: n === 0 ? 500n : 0n,
        })),
        freeShipping: false,
      },
      coupon: null,
      couponId: null,
    })),
  };
  const tax = {
    classId: vi.fn(async (id: string | null) => id ?? 'tc-default'),
    calculate: vi.fn(
      async (req: { lines: { key: string; amount: bigint }[] }) => {
        const lines = req.lines.map((l) => ({
          key: l.key,
          tax: l.amount / 10n,
          taxes: [{ rate: '0.1000' }],
        }));
        const t = lines.reduce((s, l) => s + l.tax, 0n);
        return {
          lines,
          totals: { net: 0n, tax: t, gross: 0n },
          taxes: [{ code: 'VAT', rate: '0.1', amount: t }],
          zones: [],
          rounding: 'LINE',
        };
      },
    ),
  };
  const customers = {
    groupOfCustomer: vi.fn(async () => 'vip'),
    groupByCode: vi.fn(async (code: string) => ({ code, taxClassId: null })),
  };
  const loyalty = {
    redemptionTerms: vi.fn(async () => ({
      balance: 1000,
      pointValue: 1n,
      currencyCode: 'USD',
      minRedeemPoints: 100,
      maxRedeemPercent: 50,
    })),
  };
  const pricer = new CartPricer(
    prisma as never,
    stores as never,
    products as never,
    pricing as never,
    inventory as never,
    shipping as never,
    redemptions as never,
    tax as never,
    customers as never,
    loyalty as never,
  );
  return { prisma, pricer, redemptions, loyalty, shipping, tax, stores };
}

describe('CartPricer', () => {
  it('prices lines, promotions, shipping, tax and points like checkout', async () => {
    const { pricer, prisma, loyalty } = setup();
    prisma.cart.findUnique.mockResolvedValue(
      cartRow({
        customerId: 'cust1',
        loyaltyPoints: 5000,
        items: [
          item('TEE', 3),
          item('MUG'),
          item('EBOOK'),
          item('KIT', 1, [
            { option: 'a', sku: 'TEE' },
            { option: 'a', sku: 'MUG', quantity: 2 },
          ]),
        ],
      }),
    );
    const p = await pricer.price('c1', { now: new Date('2026-11-14') });
    expect(p.customerGroupCode).toBe('vip');
    expect(
      p.lines.map((l) => [
        l.sku,
        l.unitPrice,
        l.rowTotal,
        l.discount,
        l.taxAmount,
        l.available,
      ]),
    ).toEqual([
      ['TEE', 2000n, 6000n, 500n, 550n, true],
      ['MUG', 1000n, 1000n, 0n, 100n, true],
      ['EBOOK', 2500n, 2500n, 0n, 250n, true],
      ['KIT', 4500n, 4500n, 0n, 450n, true],
    ]);
    expect(p.lines[0]).toMatchObject({
      name: 'Name p-TEE',
      attributes: { size: 'M' },
      taxRate: '0.1000',
    });
    expect(p.subtotal).toBe(14000n);
    expect(p.discountTotal).toBe(500n);
    expect(p.shipping?.id).toBe('ship-std');
    expect(p.shippingTax).toBe(80n);
    expect(p.taxTotal).toBe(1430n);
    expect(p.grandTotal).toBe(14000n - 500n + 800n + 1430n);
    // Capped at half the grand total, then by the balance (1000 points).
    expect(p.loyaltyPoints).toBe(1000);
    expect(p.amountDue).toBe(p.grandTotal - 1000n);
    expect(p.warnings).toContain('Only 1000 points can be used for this cart');
    expect(p.missing).toEqual([]);
    expect(p.format(1234n)).toContain('12.34');
    expect(loyalty.redemptionTerms).toHaveBeenCalledWith('cust1');
  });

  it('marks unavailable lines and what blocks checkout', async () => {
    const { pricer } = setup();
    const p = await pricer.price(
      cartRow({
        email: null,
        shippingAddress: null,
        shippingMethodId: 'gone',
        items: [
          item('UNKNOWN'),
          item('OFF'),
          item('HIDDEN'),
          item('GIFT'),
          item('NOPRICE'),
          item('SOLDOUT'),
          item('FEW', 2),
          item('KIT', 1, [{ option: 'zzz', sku: 'X' }]),
          { ...item('KIT', 1, [{ option: 'a', sku: 'NOPRICE' }]), id: 'kit2' },
          { ...item('KIT', 1, [{ option: 'a', sku: 'SOLDOUT' }]), id: 'kit3' },
          item('TEE'),
        ],
      }),
    );
    expect(p.lines.map((l) => l.message)).toEqual([
      'No longer available',
      'No longer available',
      'No longer available',
      'Gift cards can’t be bought online yet',
      'Not sold in this store',
      'Out of stock',
      'Only 1 available',
      'The bundle’s choices are no longer valid',
      'NOPRICE has no price in this store',
      'SOLDOUT: Out of stock',
      null,
    ]);
    expect(p.lines[0]).toMatchObject({
      sku: 'unknown',
      name: 'Unavailable item',
    });
    expect(p.missing).toEqual([
      'items',
      'email',
      'shippingAddress',
      'shippingMethod',
    ]);
    expect(p.warnings).toEqual([
      'Some items can’t be bought right now; remove or change them to check out',
      'The chosen shipping method doesn’t serve this cart any more',
    ]);
  });

  it('virtual carts need a billing address, no shipping; free shipping and coupon warnings', async () => {
    const { pricer, redemptions, shipping } = setup({ pricesIncludeTax: true });
    redemptions.evaluateLines.mockResolvedValueOnce({
      result: { lines: [], freeShipping: true },
      coupon: { status: 'EXPIRED', message: 'This coupon has expired' },
      couponId: null,
    } as never);
    const p = await pricer.price(
      cartRow({ shippingAddress: null, items: [item('EBOOK')] }),
    );
    expect(shipping.options).not.toHaveBeenCalled();
    expect(p.requiresShipping).toBe(false);
    expect(p.missing).toEqual(['billingAddress']);
    expect(p.warnings).toEqual(['This coupon has expired']);
    expect(p.grandTotal).toBe(2500n);

    redemptions.evaluateLines.mockResolvedValueOnce({
      result: { lines: [], freeShipping: true },
      coupon: null,
      couponId: null,
    } as never);
    const free = await pricer.price(cartRow({ items: [item('MUG')] }));
    expect([
      free.shippingAmount,
      free.shippingDiscount,
      free.shippingTax,
    ]).toEqual([800n, 800n, 0n]);

    const empty = await pricer.price(cartRow({ shippingAddress: null }));
    expect(empty.missing).toEqual(['items']);
  });

  it('drops points that cannot be used', async () => {
    const { pricer, loyalty } = setup();
    const c = cartRow({
      customerId: 'cust1',
      loyaltyPoints: 50,
      items: [item('MUG')],
    });
    expect((await pricer.price(c)).warnings).toEqual([
      'Not enough points can be used for this cart',
    ]);
    loyalty.redemptionTerms.mockResolvedValueOnce(null as never);
    const p = await pricer.price({ ...c, loyaltyPoints: 500 });
    expect([p.loyaltyPoints, p.warnings]).toEqual([
      0,
      ['Points can’t be used for this cart'],
    ]);
    const guest = await pricer.price({ ...c, customerId: null });
    expect(guest.customerGroupCode).toBe('guest');
    expect(guest.loyaltyPoints).toBe(0);
  });

  it('fails for unknown carts and stores', async () => {
    const { pricer, prisma } = setup();
    prisma.cart.findUnique.mockResolvedValue(null);
    await expect(pricer.price('nope')).rejects.toThrow('Cart not found');
    await expect(pricer.price(cartRow({ storeId: 'gone' }))).rejects.toThrow(
      'no longer exists',
    );
  });
});
