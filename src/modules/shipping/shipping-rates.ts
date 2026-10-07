/** Shipping rate arithmetic (pure). Amounts are minor units per currency. */
export type Amounts = Record<string, number>;

export interface RateRule {
  rateType: 'FLAT' | 'PER_ITEM';
  amounts: Amounts;
  freeOver: Amounts | null;
  countryCodes: readonly string[];
}

/**
 * The charge for a cart, or undefined when the method doesn't serve it (no amount for the currency,
 * or a destination outside its countries). Free once the discounted subtotal reaches `freeOver`.
 */
export function shippingCharge(
  rule: RateRule,
  input: {
    currencyCode: string;
    countryCode: string | null;
    units: number;
    discountedSubtotal: bigint;
  },
): bigint | undefined {
  if (
    input.countryCode &&
    rule.countryCodes.length &&
    !rule.countryCodes.includes(input.countryCode)
  )
    return undefined;
  const amount = rule.amounts[input.currencyCode];
  if (amount === undefined) return undefined;
  const threshold = rule.freeOver?.[input.currencyCode];
  if (threshold !== undefined && input.discountedSubtotal >= BigInt(threshold))
    return 0n;
  return rule.rateType === 'PER_ITEM'
    ? BigInt(amount) * BigInt(Math.max(input.units, 1))
    : BigInt(amount);
}
