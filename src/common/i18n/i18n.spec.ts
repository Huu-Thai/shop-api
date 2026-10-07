import {
  localeChain,
  negotiateLocale,
  pickTranslation,
} from './locale-chain.js';
import { SLUG_PATTERN, slugify } from './slug.js';

describe('slugify', () => {
  it.each([
    ['Áo thun Đỏ – Size M', 'ao-thun-do-size-m'],
    ['  Straße & Café  ', 'strasse-cafe'],
    ['T-Shirt (2-Pack)', 't-shirt-2-pack'],
    ['日本語', ''],
  ])('%s → %s', (input, out) => {
    expect(slugify(input)).toBe(out);
    if (out) expect(out).toMatch(SLUG_PATTERN);
  });

  it('truncates without a trailing dash', () => {
    expect(slugify('abc def ghi', 4)).toBe('abc');
  });
});

describe('localeChain', () => {
  const fb = new Map<string, string | null>([
    ['vi-VN', 'en-US'],
    ['en-GB', 'en-US'],
    ['en-US', null],
    ['a', 'b'],
    ['b', 'a'],
  ]);
  it('follows fallbacks and ends with the store default', () => {
    expect(localeChain('vi-VN', fb)).toEqual(['vi-VN', 'en-US']);
    expect(localeChain('en-GB', fb, 'fr-FR')).toEqual([
      'en-GB',
      'en-US',
      'fr-FR',
    ]);
    expect(localeChain('en-US', fb, 'en-US')).toEqual(['en-US']);
  });
  it('cuts cycles', () => {
    expect(localeChain('a', fb)).toEqual(['a', 'b']);
  });
  it('picks the first translation along the chain', () => {
    const rows = [
      { localeCode: 'en-US', name: 'Shirt' },
      { localeCode: 'fr-FR', name: 'Chemise' },
    ];
    expect(pickTranslation(rows, ['vi-VN', 'en-US'])?.name).toBe('Shirt');
    expect(pickTranslation(rows, ['de-DE'])).toBeUndefined();
  });
});

describe('negotiateLocale', () => {
  const supported = ['en-US', 'vi-VN'];
  it('honours q-values, exact match, then language', () => {
    expect(negotiateLocale('vi-VN,vi;q=0.9,en;q=0.8', supported)).toBe('vi-VN');
    expect(negotiateLocale('fr-FR, en;q=0.5', supported)).toBe('en-US');
    expect(negotiateLocale('en;q=0.2, vi;q=0.9', supported)).toBe('vi-VN');
    expect(negotiateLocale('EN-us', supported)).toBe('en-US');
  });
  it('returns undefined when nothing fits', () => {
    expect(negotiateLocale(undefined, supported)).toBeUndefined();
    expect(negotiateLocale('de, *;q=0.1', supported)).toBeUndefined();
    expect(negotiateLocale('vi;q=0', supported)).toBeUndefined();
  });
});
