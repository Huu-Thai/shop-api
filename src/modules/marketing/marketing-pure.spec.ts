import { BadRequestException } from '@nestjs/common';
import { COUPON_ALPHABET, randomCode } from './coupon-codes.js';
import {
  type CartInput,
  conditionHolds,
  distribute,
  evaluate,
  matches,
  type Rule,
} from './promotion-engine.js';
import { parseRules } from './promotion-rules.js';

const UUID = '00000000-0000-4000-8000-000000000001';

const problems = (c: unknown, a: unknown): string[] => {
  try {
    parseRules(c, a);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as never as string[];
  }
};
const messages = (c: unknown, a: unknown) => JSON.stringify(problems(c, a));

describe('promotion rules', () => {
  it('accepts and normalizes every condition and action', () => {
    const r = parseRules(
      [
        { type: 'subtotal_at_least', amounts: { USD: 5000 } },
        {
          type: 'item_quantity_at_least',
          quantity: 2,
          filter: { skus: ['A', 'A'], categoryIds: [UUID] },
        },
        { type: 'customer_group', groups: ['general', 'general'] },
      ],
      [
        {
          type: 'percent_off_items',
          percent: 12.5,
          filter: { productIds: [UUID] },
          maxQuantity: 3,
        },
        { type: 'fixed_off_items', amounts: { USD: 100 }, maxQuantity: 1 },
        { type: 'percent_off_cart', percent: 10 },
        { type: 'fixed_off_cart', amounts: { USD: 500 } },
        { type: 'buy_x_get_y', buy: 2, get: 1 },
        {
          type: 'buy_x_get_y',
          buy: 1,
          get: 1,
          percent: 50,
          filter: { skus: ['B'] },
        },
        { type: 'free_shipping' },
      ],
    );
    expect(r.conditions[1]).toEqual({
      type: 'item_quantity_at_least',
      quantity: 2,
      filter: { skus: ['A'], categoryIds: [UUID] },
    });
    expect(r.conditions[2]).toEqual({
      type: 'customer_group',
      groups: ['general'],
    });
    expect(r.actions[4]).toEqual({
      type: 'buy_x_get_y',
      buy: 2,
      get: 1,
      percent: 100,
    });
    expect(r.actions).toHaveLength(7);
    expect(
      parseRules(
        [{ type: 'item_quantity_at_least', quantity: 1 }],
        [{ type: 'percent_off_items', percent: 5 }],
      ).actions[0],
    ).toEqual({ type: 'percent_off_items', percent: 5 });
    expect(
      parseRules([], [{ type: 'fixed_off_items', amounts: { VND: 10000 } }])
        .actions[0],
    ).toEqual({ type: 'fixed_off_items', amounts: { VND: 10000 } });
  });

  it('reports every problem with its path', () => {
    expect(messages('x', [])).toContain('conditions must be an array');
    expect(messages([], [])).toContain(
      'actions must be an array of 1–10 actions',
    );
    const all = messages(
      [
        { type: 'nope' },
        { type: 'subtotal_at_least', amounts: {} },
        { type: 'subtotal_at_least', amounts: { usd: 1.5 } },
        { type: 'item_quantity_at_least', quantity: 0 },
        { type: 'item_quantity_at_least', quantity: 1, filter: 'x' },
        { type: 'item_quantity_at_least', quantity: 1, filter: {} },
        {
          type: 'item_quantity_at_least',
          quantity: 1,
          filter: { skus: [], productIds: ['x'], extra: 1 },
        },
        { type: 'customer_group', groups: ['Bad Group'] },
        { type: 'customer_group', groups: [], foo: 1 },
      ],
      [
        { type: 'percent_off_items', percent: 0 },
        { type: 'percent_off_items', percent: 10.001 },
        { type: 'fixed_off_items', amounts: 'x', maxQuantity: 0 },
        { type: 'percent_off_cart', percent: 101 },
        { type: 'fixed_off_cart', amounts: null },
        { type: 'buy_x_get_y', buy: 0, get: 1 },
        { type: 'buy_x_get_y', buy: 1, get: 1, percent: 0 },
        { type: 'free_shipping', extra: true },
        null,
      ],
    );
    for (const m of [
      'conditions[0].type must be one of',
      'conditions[1].amounts must map currency codes',
      'conditions[2].amounts.usd is not a currency code',
      'conditions[2].amounts.usd must be an integer',
      'conditions[3].quantity must be an integer between 1 and 10000',
      'conditions[4].filter must be an object',
      'conditions[6].filter.skus must list',
      'conditions[6].filter.productIds must list',
      'conditions[6].filter.extra is not allowed',
      'conditions[7].groups must list customer group codes',
      'conditions[8].foo is not allowed',
      'actions[0].percent must be a percentage',
      'actions[1].percent must be a percentage',
      'actions[2].amounts must map',
      'actions[2].maxQuantity must be an integer',
      'actions[3].percent must be a percentage',
      'actions[4].amounts must map',
      'actions[5].buy must be an integer',
      'actions[6].percent must be a percentage',
      'actions[7].extra is not allowed',
      'actions[8].type must be one of',
    ])
      expect(all).toContain(m);
    expect(
      messages(
        [{ type: 'item_quantity_at_least', quantity: 1, filter: {} }],
        [{ type: 'free_shipping' }],
      ),
    ).toContain('needs skus, productIds or categoryIds');
  });
});

const line = (
  key: string,
  unitPrice: number,
  quantity = 1,
  extra: object = {},
) => ({
  key,
  sku: key,
  productId: `p-${key}`,
  categoryIds: [] as string[],
  quantity,
  unitPrice: BigInt(unitPrice),
  ...extra,
});
const rule = (
  id: string,
  actions: Rule['actions'],
  extra: Partial<Rule> = {},
): Rule => ({
  id,
  label: id,
  priority: 0,
  stopFurther: false,
  conditions: [],
  actions,
  ...extra,
});
const cart = (
  lines: CartInput['lines'],
  extra: Partial<CartInput> = {},
): CartInput => ({
  currencyCode: 'USD',
  customerGroupCode: 'guest',
  lines,
  ...extra,
});

describe('promotion engine', () => {
  it('distributes exactly (largest remainder) and never over a weight', () => {
    expect(distribute(3n, [1n, 1n, 1n])).toEqual([1n, 1n, 1n]);
    expect(distribute(10n, [3n, 3n, 3n, 3n])).toEqual([3n, 3n, 2n, 2n]);
    expect(distribute(500n, [4000n, 1000n])).toEqual([400n, 100n]);
    expect(distribute(3n, [1n, 2n])).toEqual([1n, 2n]);
    expect(distribute(2n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(2n);
    expect(distribute(5n, [0n, 0n])).toEqual([0n, 0n]);
    expect(distribute(0n, [3n])).toEqual([0n]);
  });

  it('matches items by sku, product or category; checks conditions', () => {
    const l = line('A', 100, 1, { categoryIds: ['c1'] });
    expect(matches(l, undefined)).toBe(true);
    expect(matches(l, { skus: ['A'] })).toBe(true);
    expect(matches(l, { productIds: ['p-A'] })).toBe(true);
    expect(matches(l, { categoryIds: ['c1'] })).toBe(true);
    expect(matches(l, { skus: ['B'] })).toBe(false);
    const c = cart([l, line('B', 50, 3)]);
    expect(
      conditionHolds(
        { type: 'subtotal_at_least', amounts: { USD: 250 } },
        c,
        250n,
      ),
    ).toBe(true);
    expect(
      conditionHolds(
        { type: 'subtotal_at_least', amounts: { EUR: 1 } },
        c,
        250n,
      ),
    ).toBe(false);
    expect(
      conditionHolds({ type: 'item_quantity_at_least', quantity: 4 }, c, 0n),
    ).toBe(true);
    expect(
      conditionHolds(
        {
          type: 'item_quantity_at_least',
          quantity: 2,
          filter: { skus: ['A'] },
        },
        c,
        0n,
      ),
    ).toBe(false);
    expect(
      conditionHolds({ type: 'customer_group', groups: ['guest'] }, c, 0n),
    ).toBe(true);
  });

  it('applies item, cart and buy-x-get-y actions in priority order on what is left', () => {
    const c = cart([line('A', 1000, 2), line('B', 400, 3)], {
      shippingAmount: 500n,
    });
    const r = evaluate(c, [
      rule('z-cart', [{ type: 'fixed_off_cart', amounts: { USD: 1000 } }], {
        priority: 5,
      }),
      rule(
        'a-items',
        [
          {
            type: 'percent_off_items',
            percent: 50,
            filter: { skus: ['A'] },
            maxQuantity: 1,
          },
        ],
        { priority: 1 },
      ),
      rule(
        'b-bxgy',
        [{ type: 'buy_x_get_y', buy: 2, get: 1, filter: { skus: ['B'] } }],
        { priority: 2 },
      ),
      rule(
        'c-fixed',
        [
          {
            type: 'fixed_off_items',
            amounts: { USD: 50 },
            filter: { skus: ['B'] },
            maxQuantity: 1,
          },
          { type: 'free_shipping' },
        ],
        { priority: 3, couponCode: 'CODE' },
      ),
      rule('d-pct', [{ type: 'percent_off_cart', percent: 10 }], {
        priority: 4,
      }),
    ]);
    // A: 2000 → 50% of one unit = 500. B: 1200 → one unit free (400), then 50 off.
    expect(r.applied.map((a) => [a.promotionId, a.discount])).toEqual([
      ['a-items', 500n],
      ['b-bxgy', 400n],
      ['c-fixed', 50n],
      ['d-pct', 225n],
      ['z-cart', 1000n],
    ]);
    expect(r).toMatchObject({
      subtotal: 3200n,
      discountTotal: 2175n,
      total: 1025n,
      freeShipping: true,
      shippingDiscount: 500n,
    });
    expect(r.applied[2].couponCode).toBe('CODE');
    expect(r.lines.reduce((s, l) => s + l.discount, 0n)).toBe(2175n);
  });

  it('never discounts below zero, skips rules without the currency, and honours stopFurther', () => {
    const c = cart([line('A', 300)]);
    const r = evaluate(c, [
      rule('big', [{ type: 'fixed_off_items', amounts: { USD: 1000 } }], {
        stopFurther: true,
      }),
      rule('never', [{ type: 'percent_off_cart', percent: 10 }], {
        priority: 9,
      }),
    ]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(['big']);
    expect(r.total).toBe(0n);
    const eur = evaluate(c, [
      rule('eur', [
        { type: 'fixed_off_items', amounts: { EUR: 10 } },
        { type: 'fixed_off_cart', amounts: { EUR: 10 } },
      ]),
      rule('cond', [{ type: 'percent_off_cart', percent: 10 }], {
        conditions: [{ type: 'customer_group', groups: ['vip'] }],
      }),
      rule('cap', [{ type: 'fixed_off_cart', amounts: { USD: 9999 } }]),
    ]);
    expect(eur.applied.map((a) => [a.promotionId, a.discount])).toEqual([
      ['cap', 300n],
    ]);
    expect(eur.shippingDiscount).toBe(0n);
    // A matching rule that gives nothing doesn't stop later ones.
    const zero = evaluate(c, [
      rule(
        'a-zero',
        [{ type: 'percent_off_items', percent: 10, filter: { skus: ['X'] } }],
        { stopFurther: true },
      ),
      rule('b', [{ type: 'percent_off_cart', percent: 10 }]),
    ]);
    expect(zero.applied.map((a) => a.promotionId)).toEqual(['b']);
  });

  it('buy x get y discounts the cheapest units of each full group', () => {
    const c = cart([line('A', 1000, 2), line('B', 500, 2)]);
    const r = evaluate(c, [
      rule('r', [{ type: 'buy_x_get_y', buy: 1, get: 1, percent: 50 }]),
    ]);
    // Units by price: 1000, 1000, 500, 500 → groups (1000, 1000) and (500, 500): half off one of each.
    expect(r.lines).toEqual([
      { key: 'A', discount: 500n },
      { key: 'B', discount: 250n },
    ]);
  });
});

describe('coupon codes', () => {
  it('use the unambiguous alphabet after the prefix', () => {
    const code = randomCode('BF-', 12);
    expect(code).toMatch(/^BF-.{12}$/);
    for (const ch of code.slice(3)) expect(COUPON_ALPHABET).toContain(ch);
    expect(COUPON_ALPHABET).not.toMatch(/[01OIL]/);
  });
});
