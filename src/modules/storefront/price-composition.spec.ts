import {
  bundleFromPrice,
  bundleInStock,
  lowest,
  stockOf,
} from './price-composition.js';

const p = (amount: number, converted = false) => ({
  currency: 'USD',
  amount,
  net: amount,
  gross: amount,
  includesTax: false,
  taxRate: '0.0000',
  formatted: '',
  compareAt: 1,
  compareAtFormatted: 'x',
  tiers: [{ minQty: 2, amount: 1, formatted: '' }],
  converted,
});
const fmt = (a: number, c: string) => `${c} ${a}`;

describe('price composition', () => {
  it('lowest ignores missing prices', () => {
    expect(lowest([undefined, p(5), p(3)])?.amount).toBe(3);
    expect(lowest([])).toBeUndefined();
  });

  it('bundle "from" price sums the cheapest available selection of each required option', () => {
    const b = bundleFromPrice(
      [
        [
          { price: p(100), qty: 3, inStock: true },
          { price: p(250), qty: 1, inStock: true },
        ],
        [
          { price: p(10), qty: 1, inStock: false },
          { price: p(50, true), qty: 2, inStock: true },
        ],
      ],
      fmt,
    );
    expect(b).toMatchObject({
      amount: 350,
      net: 350,
      gross: 350,
      converted: true,
      compareAt: null,
      tiers: [],
      formatted: 'USD 350',
    });
    expect(
      bundleFromPrice([[{ price: undefined, qty: 1, inStock: true }]], fmt),
    ).toBeUndefined();
    expect(bundleFromPrice([], fmt)).toBeUndefined();
  });

  it('availability and stock defaults', () => {
    expect(
      bundleInStock([
        [{ price: undefined, qty: 1, inStock: false }],
        [{ price: undefined, qty: 1, inStock: true }],
      ]),
    ).toBe(false);
    expect(bundleInStock([])).toBe(true);
    expect(stockOf(undefined)).toEqual({
      managed: true,
      salable: 0,
      inStock: false,
    });
  });
});
