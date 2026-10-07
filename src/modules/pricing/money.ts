import { Fraction } from '../tax/fraction.js';

/** `2599` USD (2 decimals) in `en-US` → `$25.99`; VND (0 decimals) in `vi-VN` → `250.000 ₫`. */
export function formatMoney(
  amount: bigint | number,
  currency: string,
  minorUnits: number,
  locale: string,
): string {
  const major = Number(amount) / 10 ** minorUnits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(major);
  } catch {
    return `${major.toFixed(minorUnits)} ${currency}`;
  }
}

/**
 * Converts minor units between currencies: `rate` = quote per 1 base (decimal string), adjusting
 * for different minor units (USD cents → VND dong). Rounded half away from zero.
 */
export function convertMinor(
  amount: bigint,
  rate: string | Fraction,
  fromMinor: number,
  toMinor: number,
): bigint {
  const r = typeof rate === 'string' ? decimal(rate) : rate;
  return Fraction.of(amount)
    .mul(r)
    .mul(new Fraction(10n ** BigInt(toMinor), 10n ** BigInt(fromMinor)))
    .round();
}

/** `'25400.5'` → 254005/10. */
export function decimal(value: string): Fraction {
  const [int, dec = ''] = value.split('.');
  return new Fraction(BigInt(int + dec), 10n ** BigInt(dec.length));
}
