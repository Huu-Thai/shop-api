import {
  type BookScope,
  bookMatches,
  type EntryInput,
  rankBooks,
  resolveTiers,
  specificity,
  tierFor,
} from './price-resolver.js';

const book = (code: string, o: Partial<BookScope> = {}): BookScope => ({
  id: code,
  code,
  currencyCode: 'USD',
  websiteId: null,
  storeId: null,
  customerGroupId: null,
  includesTax: false,
  priority: 100,
  validFrom: null,
  validTo: null,
  isActive: true,
  ...o,
});
const ctx = {
  storeId: 's1',
  websiteId: 'w1',
  customerGroupId: 'guest',
  currencyCode: 'USD',
  at: new Date('2026-10-17T12:00:00Z'),
};
const entry = (
  priceBookId: string,
  amount: number,
  minQty = 1,
  compareAt?: number,
): EntryInput => ({
  priceBookId,
  minQty,
  amount: BigInt(amount),
  compareAtAmount: compareAt === undefined ? null : BigInt(compareAt),
});
const net = (a: bigint) => a;

describe('book matching and ranking', () => {
  it('filters by currency, scope, group, activity and validity', () => {
    expect(bookMatches(book('a'), ctx)).toBe(true);
    expect(bookMatches(book('a', { currencyCode: 'EUR' }), ctx)).toBe(false);
    expect(bookMatches(book('a', { storeId: 's2' }), ctx)).toBe(false);
    expect(bookMatches(book('a', { websiteId: 'w2' }), ctx)).toBe(false);
    expect(bookMatches(book('a', { customerGroupId: 'wholesale' }), ctx)).toBe(
      false,
    );
    expect(bookMatches(book('a', { isActive: false }), ctx)).toBe(false);
    expect(
      bookMatches(book('a', { validFrom: new Date('2026-10-18') }), ctx),
    ).toBe(false);
    expect(
      bookMatches(
        book('a', { validTo: new Date('2026-10-17T12:00:00Z') }),
        ctx,
      ),
    ).toBe(false);
  });

  it('ranks by priority, then specificity, then code', () => {
    const ranked = rankBooks(
      [
        book('global'),
        book('website', { websiteId: 'w1' }),
        book('store-guest', { storeId: 's1', customerGroupId: 'guest' }),
        book('sale', { priority: 10 }),
        book('b-website', { websiteId: 'w1' }),
      ],
      ctx,
    );
    expect(ranked.map((b) => b.code)).toEqual([
      'sale',
      'store-guest',
      'b-website',
      'website',
      'global',
    ]);
    expect(specificity(book('x', { storeId: 's', customerGroupId: 'g' }))).toBe(
      5,
    );
  });
});

describe('resolveTiers', () => {
  it('takes the base price from the best book that prices the variant', () => {
    const ranked = rankBooks(
      [book('sale', { priority: 10 }), book('list')],
      ctx,
    );
    expect(resolveTiers(ranked, [entry('list', 2000)], net)).toMatchObject([
      { minQty: 1, amount: 2000n, book: { code: 'list' } },
    ]);
    expect(
      resolveTiers(
        ranked,
        [entry('list', 2000), entry('sale', 1500, 1, 2000)],
        net,
      ),
    ).toMatchObject([
      { amount: 1500n, compareAtAmount: 2000n, book: { code: 'sale' } },
    ]);
    expect(resolveTiers(ranked, [entry('other', 1)], net)).toEqual([]);
  });

  it('quantity tiers only ever lower the price (lowest across books wins)', () => {
    const ranked = rankBooks(
      [book('list'), book('volume', { priority: 50 })],
      ctx,
    );
    const tiers = resolveTiers(
      ranked,
      [
        entry('list', 1000),
        entry('list', 900, 10),
        entry('volume', 850, 10),
        entry('list', 950, 20),
        entry('volume', 800, 50),
      ],
      net,
    );
    expect(tiers.map((t) => [t.minQty, Number(t.amount), t.book.code])).toEqual(
      [
        [1, 1000, 'list'],
        [10, 850, 'volume'],
        [50, 800, 'volume'],
      ],
    );
    expect(tierFor(tiers, 1)?.minQty).toBe(1);
    expect(tierFor(tiers, 49)?.minQty).toBe(10);
    expect(tierFor(tiers, 500)?.minQty).toBe(50);
    expect(tierFor(tiers, 0)).toBeUndefined();
  });

  it('compares tax-inclusive and net books on the normalised value', () => {
    const ranked = rankBooks(
      [book('gross', { includesTax: true }), book('net-volume')],
      ctx,
    );
    // gross 1100 incl. 10 % = 1000 net; a net tier of 1050 is NOT cheaper.
    const toNet = (a: bigint, b: BookScope) =>
      b.includesTax ? (a * 10n) / 11n : a;
    expect(
      resolveTiers(
        ranked,
        [
          entry('gross', 1100),
          entry('net-volume', 1050, 5),
          entry('net-volume', 900, 10),
        ],
        toNet,
      ).map((t) => t.minQty),
    ).toEqual([1, 10]);
  });
});
