import { BadRequestException } from '@nestjs/common';

/**
 * Typed promotion rules (stored as JSONB, validated on save). Conditions must all hold; actions
 * apply in order. Amounts are minor units per currency (`{ "USD": 5000, "VND": 1000000 }`): a rule
 * without an amount for the cart's currency doesn't apply.
 */
export interface ItemFilter {
  skus?: string[];
  productIds?: string[];
  categoryIds?: string[];
}

export type Amounts = Record<string, number>;

export type Condition =
  | { type: 'subtotal_at_least'; amounts: Amounts }
  | { type: 'item_quantity_at_least'; quantity: number; filter?: ItemFilter }
  | { type: 'customer_group'; groups: string[] };

export type Action =
  | {
      type: 'percent_off_items';
      percent: number;
      filter?: ItemFilter;
      maxQuantity?: number;
    }
  | {
      type: 'fixed_off_items';
      amounts: Amounts;
      filter?: ItemFilter;
      maxQuantity?: number;
    }
  | { type: 'percent_off_cart'; percent: number }
  | { type: 'fixed_off_cart'; amounts: Amounts }
  | {
      type: 'buy_x_get_y';
      buy: number;
      get: number;
      percent?: number;
      filter?: ItemFilter;
    }
  | { type: 'free_shipping' };

export const CONDITION_TYPES = [
  'subtotal_at_least',
  'item_quantity_at_least',
  'customer_group',
] as const;
export const ACTION_TYPES = [
  'percent_off_items',
  'fixed_off_items',
  'percent_off_cart',
  'fixed_off_cart',
  'buy_x_get_y',
  'free_shipping',
] as const;

const MAX_ITEMS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

type Obj = Record<string, unknown>;

class Problems {
  readonly list: string[] = [];
  add(path: string, msg: string) {
    this.list.push(`${path} ${msg}`);
  }
}

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function allowed(o: Obj, keys: string[], path: string, p: Problems) {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) p.add(`${path}.${k}`, 'is not allowed');
}

function int(
  v: unknown,
  path: string,
  p: Problems,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    p.add(path, `must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return v as number;
}

function percent(v: unknown, path: string, p: Problems): number | undefined {
  if (
    typeof v !== 'number' ||
    !(v > 0 && v <= 100) ||
    Math.round(v * 100) !== v * 100
  ) {
    p.add(path, 'must be a percentage above 0 and at most 100 (2 decimals)');
    return undefined;
  }
  return v;
}

function amounts(v: unknown, path: string, p: Problems): Amounts | undefined {
  if (!isObj(v) || !Object.keys(v).length) {
    p.add(path, 'must map currency codes to amounts in minor units');
    return undefined;
  }
  const out: Amounts = {};
  for (const [c, a] of Object.entries(v)) {
    if (!CURRENCY.test(c)) p.add(`${path}.${c}`, 'is not a currency code');
    const n = int(a, `${path}.${c}`, p, 1);
    if (n !== undefined) out[c] = n;
  }
  return out;
}

function filter(v: unknown, path: string, p: Problems): ItemFilter | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) {
    p.add(path, 'must be an object');
    return undefined;
  }
  allowed(v, ['skus', 'productIds', 'categoryIds'], path, p);
  const out: ItemFilter = {};
  for (const key of ['skus', 'productIds', 'categoryIds'] as const) {
    const list = v[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > MAX_ITEMS ||
      !list.every(
        (x) =>
          typeof x === 'string' &&
          (key === 'skus' ? x.length > 0 && x.length <= 64 : UUID.test(x)),
      )
    ) {
      p.add(
        `${path}.${key}`,
        key === 'skus'
          ? `must list 1–${MAX_ITEMS} SKUs`
          : `must list 1–${MAX_ITEMS} ids`,
      );
      continue;
    }
    out[key] = [...new Set(list as string[])];
  }
  if (!Object.keys(out).length && !p.list.length)
    p.add(
      path,
      'needs skus, productIds or categoryIds (omit it for every item)',
    );
  return out;
}

function condition(
  v: unknown,
  path: string,
  p: Problems,
): Condition | undefined {
  if (!isObj(v) || !CONDITION_TYPES.includes(v.type as never)) {
    p.add(`${path}.type`, `must be one of ${CONDITION_TYPES.join(', ')}`);
    return undefined;
  }
  switch (v.type) {
    case 'subtotal_at_least': {
      allowed(v, ['type', 'amounts'], path, p);
      const a = amounts(v.amounts, `${path}.amounts`, p);
      return a && { type: v.type, amounts: a };
    }
    case 'item_quantity_at_least': {
      allowed(v, ['type', 'quantity', 'filter'], path, p);
      const q = int(v.quantity, `${path}.quantity`, p, 1, 10_000);
      const f = filter(v.filter, `${path}.filter`, p);
      return q === undefined
        ? undefined
        : { type: v.type, quantity: q, ...(f ? { filter: f } : {}) };
    }
    default: {
      allowed(v, ['type', 'groups'], path, p);
      const g = v.groups;
      if (
        !Array.isArray(g) ||
        !g.length ||
        !g.every(
          (x) => typeof x === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(x),
        )
      ) {
        p.add(`${path}.groups`, 'must list customer group codes');
        return undefined;
      }
      return { type: 'customer_group', groups: [...new Set(g as string[])] };
    }
  }
}

function action(v: unknown, path: string, p: Problems): Action | undefined {
  if (!isObj(v) || !ACTION_TYPES.includes(v.type as never)) {
    p.add(`${path}.type`, `must be one of ${ACTION_TYPES.join(', ')}`);
    return undefined;
  }
  const f = () => filter(v.filter, `${path}.filter`, p);
  const maxQ = () =>
    v.maxQuantity === undefined
      ? undefined
      : int(v.maxQuantity, `${path}.maxQuantity`, p, 1, 10_000);
  switch (v.type) {
    case 'percent_off_items': {
      allowed(v, ['type', 'percent', 'filter', 'maxQuantity'], path, p);
      const pc = percent(v.percent, `${path}.percent`, p);
      const fl = f();
      const mq = maxQ();
      return pc === undefined
        ? undefined
        : {
            type: v.type,
            percent: pc,
            ...(fl ? { filter: fl } : {}),
            ...(mq ? { maxQuantity: mq } : {}),
          };
    }
    case 'fixed_off_items': {
      allowed(v, ['type', 'amounts', 'filter', 'maxQuantity'], path, p);
      const a = amounts(v.amounts, `${path}.amounts`, p);
      const fl = f();
      const mq = maxQ();
      return (
        a && {
          type: v.type,
          amounts: a,
          ...(fl ? { filter: fl } : {}),
          ...(mq ? { maxQuantity: mq } : {}),
        }
      );
    }
    case 'percent_off_cart': {
      allowed(v, ['type', 'percent'], path, p);
      const pc = percent(v.percent, `${path}.percent`, p);
      return pc === undefined ? undefined : { type: v.type, percent: pc };
    }
    case 'fixed_off_cart': {
      allowed(v, ['type', 'amounts'], path, p);
      const a = amounts(v.amounts, `${path}.amounts`, p);
      return a && { type: v.type, amounts: a };
    }
    case 'buy_x_get_y': {
      allowed(v, ['type', 'buy', 'get', 'percent', 'filter'], path, p);
      const buy = int(v.buy, `${path}.buy`, p, 1, 1000);
      const get = int(v.get, `${path}.get`, p, 1, 1000);
      const pc =
        v.percent === undefined
          ? 100
          : percent(v.percent, `${path}.percent`, p);
      const fl = f();
      return buy === undefined || get === undefined || pc === undefined
        ? undefined
        : {
            type: v.type,
            buy,
            get,
            percent: pc,
            ...(fl ? { filter: fl } : {}),
          };
    }
    default:
      allowed(v, ['type'], path, p);
      return { type: 'free_shipping' };
  }
}

/** Validates and normalizes rules; throws 400 listing every problem. */
export function parseRules(
  conditions: unknown,
  actions: unknown,
): { conditions: Condition[]; actions: Action[] } {
  const p = new Problems();
  const conds: Condition[] = [];
  const acts: Action[] = [];
  if (!Array.isArray(conditions) || conditions.length > 20)
    p.add('conditions', 'must be an array of at most 20 conditions');
  else
    conditions.forEach((c, i) => {
      const r = condition(c, `conditions[${i}]`, p);
      if (r) conds.push(r);
    });
  if (!Array.isArray(actions) || !actions.length || actions.length > 10)
    p.add('actions', 'must be an array of 1–10 actions');
  else
    actions.forEach((a, i) => {
      const r = action(a, `actions[${i}]`, p);
      if (r) acts.push(r);
    });
  if (p.list.length) throw new BadRequestException(p.list);
  return { conditions: conds, actions: acts };
}
