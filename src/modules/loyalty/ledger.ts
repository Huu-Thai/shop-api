/** Pure loyalty arithmetic (PLAN.md §9.8). */

export interface Credit {
  id: string;
  remaining: number;
}

/**
 * Takes `points` from credits in the given (FIFO) order. Returns what each credit gives and the
 * part that could not be covered.
 */
export function allocate(
  credits: readonly Credit[],
  points: number,
): { allocations: { creditId: string; points: number }[]; shortfall: number } {
  const allocations: { creditId: string; points: number }[] = [];
  let left = points;
  for (const c of credits) {
    if (left <= 0) break;
    const take = Math.min(c.remaining, left);
    if (take > 0) {
      allocations.push({ creditId: c.id, points: take });
      left -= take;
    }
  }
  return { allocations, shortfall: Math.max(left, 0) };
}

/** floor(amount / spendPerPoint) × multiplier (basis points), rounded down. */
export function earnedPoints(
  amount: bigint,
  spendPerPoint: bigint,
  multiplierBp: number,
): number {
  if (amount <= 0n) return 0;
  const base = amount / spendPerPoint;
  return Number((base * BigInt(multiplierBp)) / 10_000n);
}

/** Points to reverse for a refund of `refunded` out of an order that earned `earned` on `amount`. */
export function reversalPoints(
  earned: number,
  amount: bigint | null,
  refunded: bigint | undefined,
): number {
  if (refunded === undefined || !amount || amount <= 0n || refunded >= amount)
    return earned;
  return Number((BigInt(earned) * refunded) / amount);
}

export interface TierRule {
  id: string;
  code: string;
  name: string;
  thresholdPoints: number;
  multiplierBp: number;
}

/** The highest tier whose threshold the points reach (tiers in any order). */
export function tierFor<T extends TierRule>(
  tiers: readonly T[],
  points: number,
): T | null {
  return (
    [...tiers]
      .sort((a, b) => b.thresholdPoints - a.thresholdPoints)
      .find((t) => points >= t.thresholdPoints) ?? null
  );
}

/** The next tier above the current one, with the points still needed. */
export function nextTier<T extends TierRule>(
  tiers: readonly T[],
  points: number,
): (T & { pointsNeeded: number }) | null {
  const next = [...tiers]
    .sort((a, b) => a.thresholdPoints - b.thresholdPoints)
    .find((t) => t.thresholdPoints > points);
  return next ? { ...next, pointsNeeded: next.thresholdPoints - points } : null;
}
