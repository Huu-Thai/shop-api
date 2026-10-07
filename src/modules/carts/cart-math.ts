import { BadRequestException } from '@nestjs/common';
import type { CartLineFacts } from '../products/products.query.js';

/** A bundle choice as sent by the shopper and stored on the cart line. */
export interface BundleChoice {
  option: string;
  sku: string;
  /** Defaults to the selection's quantity. */
  quantity?: number;
}

export interface BundleComponent {
  option: string;
  variantId: string;
  sku: string;
  quantity: number;
}

/**
 * Validates bundle choices against the bundle's options: known options and selections, one
 * selection for single-choice options, quantities only where they may change, required options
 * filled (their default selection when none was chosen). Returns the components (per bundle unit).
 */
export function resolveBundle(
  facts: Pick<CartLineFacts, 'bundleOptions' | 'productSku'>,
  choices: readonly BundleChoice[],
): BundleComponent[] {
  const byOption = new Map<string, BundleChoice[]>();
  for (const c of choices) {
    const option = facts.bundleOptions.find((o) => o.code === c.option);
    if (!option)
      throw new BadRequestException(
        `${facts.productSku} has no option "${c.option}"`,
      );
    byOption.set(c.option, [...(byOption.get(c.option) ?? []), c]);
  }
  const out: BundleComponent[] = [];
  for (const option of facts.bundleOptions) {
    let chosen = byOption.get(option.code) ?? [];
    if (!chosen.length) {
      const defaults = option.selections.filter(
        (s) => s.isDefault && s.enabled,
      );
      if (!defaults.length) {
        if (option.isRequired)
          throw new BadRequestException(`Choose an item for "${option.code}"`);
        continue;
      }
      chosen = defaults.map((d) => ({
        option: option.code,
        sku: d.sku,
        quantity: d.qty,
      }));
    }
    const single =
      option.inputType === 'SELECT' || option.inputType === 'RADIO';
    if (single && chosen.length > 1)
      throw new BadRequestException(`Choose one item for "${option.code}"`);
    const seen = new Set<string>();
    for (const c of chosen) {
      const sel = option.selections.find((s) => s.sku === c.sku);
      if (!sel || !sel.enabled)
        throw new BadRequestException(
          `"${c.sku}" is not a choice of "${option.code}"`,
        );
      if (seen.has(c.sku))
        throw new BadRequestException(
          `"${c.sku}" is chosen twice for "${option.code}"`,
        );
      seen.add(c.sku);
      const quantity = c.quantity ?? sel.qty;
      if (!sel.canChangeQty && quantity !== sel.qty)
        throw new BadRequestException(
          `The quantity of "${c.sku}" in "${option.code}" is fixed at ${sel.qty}`,
        );
      out.push({
        option: option.code,
        variantId: sel.variantId,
        sku: sel.sku,
        quantity,
      });
    }
  }
  if (!out.length)
    throw new BadRequestException(`Choose the items of ${facts.productSku}`);
  return out;
}

/** Canonical choices: the same bundle with the same choices is one cart line. */
export function choicesSignature(
  components: readonly BundleComponent[],
): string {
  return components
    .map((c) => `${c.option}:${c.sku}:${c.quantity}`)
    .sort()
    .join('|')
    .slice(0, 512);
}

/** The unit price for a quantity: the best tier the quantity reaches, else the base amount. */
export function unitPriceFor(
  price: {
    amount: number;
    tiers: readonly { minQty: number; amount: number }[];
  },
  quantity: number,
): number {
  let best = price.amount;
  for (const t of price.tiers)
    if (quantity >= t.minQty && t.amount < best) best = t.amount;
  return best;
}
