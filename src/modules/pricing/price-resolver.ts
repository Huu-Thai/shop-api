/**
 * Price resolution (PLAN.md §9): which price book applies to a variant in a store, for a customer
 * group, currency, date and quantity. Pure — the price indexer and the admin preview both use it.
 */

export interface BookScope {
  id: string;
  code: string;
  currencyCode: string;
  websiteId: string | null;
  storeId: string | null;
  customerGroupId: string | null;
  includesTax: boolean;
  priority: number;
  validFrom: Date | null;
  validTo: Date | null;
  isActive: boolean;
}

export interface PriceContext {
  storeId: string;
  websiteId: string;
  customerGroupId: string;
  currencyCode: string;
  at: Date;
}

export interface EntryInput {
  priceBookId: string;
  minQty: number;
  amount: bigint;
  compareAtAmount: bigint | null;
}

export interface ResolvedTier {
  minQty: number;
  amount: bigint;
  compareAtAmount: bigint | null;
  book: BookScope;
}

export function bookMatches(b: BookScope, c: PriceContext): boolean {
  return (
    b.isActive &&
    b.currencyCode === c.currencyCode &&
    (!b.storeId || b.storeId === c.storeId) &&
    (!b.websiteId || b.websiteId === c.websiteId) &&
    (!b.customerGroupId || b.customerGroupId === c.customerGroupId) &&
    (!b.validFrom || b.validFrom <= c.at) &&
    (!b.validTo || c.at < b.validTo)
  );
}

/** Store beats website beats global; a group-specific book beats an all-groups book. */
export const specificity = (b: BookScope) =>
  (b.storeId ? 4 : b.websiteId ? 2 : 0) + (b.customerGroupId ? 1 : 0);

/** Matching books, best first: lowest priority, then most specific, then code (deterministic). */
export function rankBooks(
  books: readonly BookScope[],
  c: PriceContext,
): BookScope[] {
  return books
    .filter((b) => bookMatches(b, c))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        specificity(b) - specificity(a) ||
        a.code.localeCompare(b.code),
    );
}

/**
 * Tier list for one variant. The base (qty 1) price comes from the best-ranked book that prices the
 * variant; quantity tiers from any matching book only ever lower it (lowest wins, compared on
 * `comparable` — the caller normalises tax-inclusive and net books). Returns rows with strictly
 * decreasing prices by min qty; empty when no matching book prices the variant.
 */
export function resolveTiers(
  ranked: readonly BookScope[],
  entries: readonly EntryInput[],
  comparable: (amount: bigint, book: BookScope) => bigint,
): ResolvedTier[] {
  const byId = new Map(ranked.map((b) => [b.id, b]));
  const usable = entries.filter((e) => byId.has(e.priceBookId));
  const base = ranked
    .map((b) => usable.find((e) => e.priceBookId === b.id && e.minQty === 1))
    .find(Boolean);
  if (!base) return [];
  const toTier = (e: EntryInput): ResolvedTier => ({
    minQty: e.minQty,
    amount: e.amount,
    compareAtAmount: e.compareAtAmount,
    book: byId.get(e.priceBookId)!,
  });
  const tiers = [toTier(base)];
  let best = comparable(base.amount, tiers[0].book);
  const higher = [
    ...new Set(usable.filter((e) => e.minQty > 1).map((e) => e.minQty)),
  ].sort((a, b) => a - b);
  for (const qty of higher) {
    const candidates = usable.filter((e) => e.minQty === qty).map(toTier);
    const cheapest = candidates.reduce((a, b) =>
      comparable(b.amount, b.book) < comparable(a.amount, a.book) ? b : a,
    );
    const value = comparable(cheapest.amount, cheapest.book);
    if (value < best) {
      tiers.push(cheapest);
      best = value;
    }
  }
  return tiers;
}

/** The tier that applies to a quantity. */
export const tierFor = <T extends { minQty: number }>(
  tiers: readonly T[],
  qty: number,
): T | undefined => [...tiers].reverse().find((t) => t.minQty <= qty);
