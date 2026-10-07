/** Pure allocation of a requested quantity over sources in priority order. */

export interface SourceStock {
  inventoryId: string;
  sourceId: string;
  quantity: number;
  reserved: number;
  safetyStock: number;
}

export const salableOf = (
  s: Pick<SourceStock, 'quantity' | 'reserved' | 'safetyStock'>,
) => Math.max(0, s.quantity - s.reserved - s.safetyStock);

/**
 * Takes from the first source as much as it can, then the next (fewest shipments for typical
 * orders). Returns undefined when the sources can't cover the quantity together.
 */
export function allocate(
  sources: readonly SourceStock[],
  quantity: number,
): { source: SourceStock; quantity: number }[] | undefined {
  const out: { source: SourceStock; quantity: number }[] = [];
  let left = quantity;
  for (const s of sources) {
    if (left <= 0) break;
    const take = Math.min(left, salableOf(s));
    if (take > 0) {
      out.push({ source: s, quantity: take });
      left -= take;
    }
  }
  return left > 0 ? undefined : out;
}
