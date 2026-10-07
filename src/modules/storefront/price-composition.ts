import type { PriceView } from '../pricing/pricing.query.js';
import type { Salable } from '../inventory/inventory.query.js';

/** Lowest price (by displayed amount) — the "from" price of a configurable product. */
export function lowest(
  prices: readonly (PriceView | undefined)[],
): PriceView | undefined {
  return prices
    .filter((p): p is PriceView => !!p)
    .reduce<PriceView | undefined>(
      (a, b) => (!a || b.amount < a.amount ? b : a),
      undefined,
    );
}

export interface BundlePart {
  price: PriceView | undefined;
  qty: number;
  inStock: boolean;
}

/**
 * DYNAMIC bundle "from" price: for every required option the cheapest in-stock selection × qty.
 * Undefined when a required option has no priced, available selection (the bundle can't be sold).
 */
export function bundleFromPrice(
  requiredOptions: readonly (readonly BundlePart[])[],
  format: (amount: number, currency: string) => string,
): PriceView | undefined {
  let total: PriceView | undefined;
  for (const option of requiredOptions) {
    const candidates = option.filter((s) => s.price && s.inStock);
    if (!candidates.length) return undefined;
    const best = candidates.reduce((a, b) =>
      b.price!.amount * b.qty < a.price!.amount * a.qty ? b : a,
    );
    const p = best.price!;
    const part = {
      amount: p.amount * best.qty,
      net: p.net * best.qty,
      gross: p.gross * best.qty,
    };
    total = total
      ? {
          ...total,
          amount: total.amount + part.amount,
          net: total.net + part.net,
          gross: total.gross + part.gross,
          converted: total.converted || p.converted,
        }
      : { ...p, ...part, compareAt: null, compareAtFormatted: null, tiers: [] };
  }
  return total && { ...total, formatted: format(total.amount, total.currency) };
}

/** A bundle is available when every required option has an available selection. */
export function bundleInStock(
  requiredOptions: readonly (readonly BundlePart[])[],
): boolean {
  return requiredOptions.every((o) => o.some((s) => s.inStock));
}

export const stockOf = (s: Salable | undefined) =>
  s ?? { managed: true, salable: 0, inStock: false };
