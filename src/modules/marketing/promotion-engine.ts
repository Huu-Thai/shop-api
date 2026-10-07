import type { Action, Condition, ItemFilter } from './promotion-rules.js';

/** A cart line as the engine sees it. `unitPrice` is what the cart charges per unit (minor units). */
export interface CartLine {
  key: string;
  productId: string;
  sku: string;
  categoryIds: readonly string[];
  quantity: number;
  unitPrice: bigint;
}

export interface CartInput {
  currencyCode: string;
  customerGroupCode: string;
  lines: readonly CartLine[];
  shippingAmount?: bigint;
}

export interface Rule {
  id: string;
  label: string;
  priority: number;
  stopFurther: boolean;
  conditions: readonly Condition[];
  actions: readonly Action[];
  /** The coupon that unlocked this rule, if it needs one. */
  couponCode?: string | null;
}

export interface AppliedRule {
  promotionId: string;
  label: string;
  discount: bigint;
  freeShipping: boolean;
  couponCode: string | null;
}

export interface Evaluation {
  subtotal: bigint;
  discountTotal: bigint;
  /** Subtotal minus discounts (shipping not included). */
  total: bigint;
  freeShipping: boolean;
  shippingDiscount: bigint;
  lines: { key: string; discount: bigint }[];
  applied: AppliedRule[];
}

const BP = 10_000n;
const bp = (percent: number) => BigInt(Math.round(percent * 100));

export function matches(line: CartLine, f: ItemFilter | undefined): boolean {
  if (!f) return true;
  return (
    !!f.skus?.includes(line.sku) ||
    !!f.productIds?.includes(line.productId) ||
    !!f.categoryIds?.some((c) => line.categoryIds.includes(c))
  );
}

export function conditionHolds(
  c: Condition,
  cart: CartInput,
  subtotal: bigint,
): boolean {
  switch (c.type) {
    case 'subtotal_at_least': {
      const min = c.amounts[cart.currencyCode];
      return min !== undefined && subtotal >= BigInt(min);
    }
    case 'item_quantity_at_least':
      return (
        cart.lines
          .filter((l) => matches(l, c.filter))
          .reduce((n, l) => n + l.quantity, 0) >= c.quantity
      );
    case 'customer_group':
      return c.groups.includes(cart.customerGroupCode);
  }
}

/**
 * Splits `amount` over `weights` proportionally (largest remainder), so the parts add up exactly
 * and no part exceeds its weight when amount ≤ Σ weights.
 */
export function distribute(
  amount: bigint,
  weights: readonly bigint[],
): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total <= 0n || amount <= 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (amount * w) / total);
  let rest = amount - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (amount * w) % total }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (rest <= 0n) break;
    if (parts[i] < weights[i]) {
      parts[i]++;
      rest--;
    }
  }
  return parts;
}

/**
 * Cart promotion engine (PLAN.md §9): rules by priority (then id); a rule applies when all its
 * conditions hold on the cart; its actions discount what is left of each line after earlier rules
 * (a line never goes below zero); `stopFurther` ends evaluation. Pure and deterministic.
 */
export function evaluate(cart: CartInput, rules: readonly Rule[]): Evaluation {
  const lineTotal = (l: CartLine) => l.unitPrice * BigInt(l.quantity);
  const subtotal = cart.lines.reduce((s, l) => s + lineTotal(l), 0n);
  const remaining = new Map(cart.lines.map((l) => [l.key, lineTotal(l)]));
  const applied: AppliedRule[] = [];
  let freeShipping = false;

  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
  for (const rule of ordered) {
    if (!rule.conditions.every((c) => conditionHolds(c, cart, subtotal)))
      continue;
    let discount = 0n;
    let ruleFreeShipping = false;
    const take = (key: string, amount: bigint) => {
      const left = remaining.get(key)!;
      const d = amount > left ? left : amount < 0n ? 0n : amount;
      remaining.set(key, left - d);
      discount += d;
    };
    for (const a of rule.actions) {
      switch (a.type) {
        case 'percent_off_items':
          for (const l of cart.lines.filter((x) => matches(x, a.filter))) {
            const units = BigInt(
              Math.min(l.quantity, a.maxQuantity ?? l.quantity),
            );
            const base = (remaining.get(l.key)! * units) / BigInt(l.quantity);
            take(l.key, (base * bp(a.percent)) / BP);
          }
          break;
        case 'fixed_off_items': {
          const per = a.amounts[cart.currencyCode];
          if (per === undefined) break;
          for (const l of cart.lines.filter((x) => matches(x, a.filter))) {
            const units = Math.min(l.quantity, a.maxQuantity ?? l.quantity);
            take(l.key, BigInt(per) * BigInt(units));
          }
          break;
        }
        case 'percent_off_cart':
        case 'fixed_off_cart': {
          const keys = cart.lines.map((l) => l.key);
          const weights = keys.map((k) => remaining.get(k)!);
          const left = weights.reduce((s, w) => s + w, 0n);
          let amount: bigint;
          if (a.type === 'percent_off_cart')
            amount = (left * bp(a.percent)) / BP;
          else {
            const fixed = a.amounts[cart.currencyCode];
            if (fixed === undefined) break;
            amount = BigInt(fixed) < left ? BigInt(fixed) : left;
          }
          distribute(amount, weights).forEach((d, i) => take(keys[i], d));
          break;
        }
        case 'buy_x_get_y': {
          // Units of matching lines, dearest first; in every full group of buy + get units the
          // cheapest `get` units are discounted.
          const units = cart.lines
            .filter((l) => matches(l, a.filter))
            .flatMap((l) => Array.from({ length: l.quantity }, () => l))
            .sort((x, y) =>
              y.unitPrice > x.unitPrice
                ? 1
                : y.unitPrice < x.unitPrice
                  ? -1
                  : x.key.localeCompare(y.key),
            );
          const group = a.buy + a.get;
          const groups = Math.floor(units.length / group);
          for (let g = 0; g < groups; g++)
            for (let k = group - a.get; k < group; k++) {
              const l = units[g * group + k];
              const unitLeft = remaining.get(l.key)! / BigInt(l.quantity) || 0n;
              const perUnit =
                ((l.unitPrice < unitLeft ? l.unitPrice : unitLeft) *
                  bp(a.percent ?? 100)) /
                BP;
              take(l.key, perUnit);
            }
          break;
        }
        case 'free_shipping':
          ruleFreeShipping = true;
          break;
      }
    }
    if (discount > 0n || ruleFreeShipping) {
      applied.push({
        promotionId: rule.id,
        label: rule.label,
        discount,
        freeShipping: ruleFreeShipping,
        couponCode: rule.couponCode ?? null,
      });
      freeShipping ||= ruleFreeShipping;
      if (rule.stopFurther) break;
    }
  }

  const lines = cart.lines.map((l) => ({
    key: l.key,
    discount: lineTotal(l) - remaining.get(l.key)!,
  }));
  const discountTotal = lines.reduce((s, l) => s + l.discount, 0n);
  return {
    subtotal,
    discountTotal,
    total: subtotal - discountTotal,
    freeShipping,
    shippingDiscount: freeShipping ? (cart.shippingAmount ?? 0n) : 0n,
    lines,
    applied,
  };
}
