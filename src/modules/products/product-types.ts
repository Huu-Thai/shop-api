import type { ProductType } from '../../database/generated/prisma/client.js';
import type { AttributeDef } from '../catalog/attribute-values.js';

/** Types with exactly one (default) variant; CONFIGURABLE has one per option combination. */
export const SINGLE_VARIANT_TYPES: ReadonlySet<ProductType> = new Set([
  'SIMPLE',
  'VIRTUAL',
  'BUNDLE',
  'GIFT_CARD',
]);
/** Variants of these product types may be sold inside a bundle (Magento: simple and virtual). */
export const BUNDLEABLE_TYPES: ReadonlySet<ProductType> = new Set([
  'SIMPLE',
  'VIRTUAL',
  'CONFIGURABLE',
]);
export const MAX_CONFIGURABLE_AXES = 5;

export interface BundleTypeOptions {
  /** DYNAMIC: price = sum of selections; FIXED: the bundle's own price (Phase 2 pricing). */
  priceType: 'DYNAMIC' | 'FIXED';
  shipmentType: 'TOGETHER' | 'SEPARATELY';
}

export interface GiftCardTypeOptions {
  cardType: 'VIRTUAL' | 'PHYSICAL';
  /** Preset amounts in minor units per currency. */
  amounts: { currency: string; amount: number }[];
  allowOpenAmount: boolean;
  openAmountMin?: number;
  openAmountMax?: number;
  /** Validity after purchase; null = never expires. */
  lifetimeDays: number | null;
}

type Result<T> = { value: T; errors: string[] };
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isMinor = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Validates `typeOptions` for the product type and fills defaults. */
export function validateTypeOptions(
  type: ProductType,
  raw: unknown,
): Result<Record<string, unknown>> {
  const input = raw ?? {};
  if (!isObj(input))
    return { value: {}, errors: ['typeOptions must be an object'] };
  switch (type) {
    case 'BUNDLE': {
      const errors: string[] = [];
      const priceType = input.priceType ?? 'DYNAMIC';
      const shipmentType = input.shipmentType ?? 'TOGETHER';
      if (priceType !== 'DYNAMIC' && priceType !== 'FIXED')
        errors.push('typeOptions.priceType must be DYNAMIC or FIXED');
      if (shipmentType !== 'TOGETHER' && shipmentType !== 'SEPARATELY')
        errors.push('typeOptions.shipmentType must be TOGETHER or SEPARATELY');
      unknownKeys(input, ['priceType', 'shipmentType'], errors);
      return {
        value: { priceType, shipmentType } satisfies Record<
          keyof BundleTypeOptions,
          unknown
        >,
        errors,
      };
    }
    case 'GIFT_CARD': {
      const errors: string[] = [];
      const cardType = input.cardType ?? 'VIRTUAL';
      if (cardType !== 'VIRTUAL' && cardType !== 'PHYSICAL')
        errors.push('typeOptions.cardType must be VIRTUAL or PHYSICAL');
      const amounts = input.amounts ?? [];
      if (
        !Array.isArray(amounts) ||
        amounts.some(
          (a) =>
            !isObj(a) ||
            typeof a.currency !== 'string' ||
            !/^[A-Z]{3}$/.test(a.currency) ||
            !isMinor(a.amount),
        )
      )
        errors.push(
          'typeOptions.amounts must be a list of { currency: "USD", amount: <positive integer minor units> }',
        );
      const allowOpenAmount = input.allowOpenAmount ?? false;
      if (typeof allowOpenAmount !== 'boolean')
        errors.push('typeOptions.allowOpenAmount must be a boolean');
      const { openAmountMin, openAmountMax } = input;
      if (allowOpenAmount === true) {
        if (
          !isMinor(openAmountMin) ||
          !isMinor(openAmountMax) ||
          openAmountMin > openAmountMax
        )
          errors.push(
            'typeOptions.openAmountMin/openAmountMax must be positive minor units with min ≤ max',
          );
      } else if (Array.isArray(amounts) && !amounts.length)
        errors.push('A gift card needs preset amounts or an open amount');
      const lifetimeDays = input.lifetimeDays ?? null;
      if (
        lifetimeDays !== null &&
        !(Number.isSafeInteger(lifetimeDays) && (lifetimeDays as number) > 0)
      )
        errors.push(
          'typeOptions.lifetimeDays must be a positive integer or null',
        );
      unknownKeys(
        input,
        [
          'cardType',
          'amounts',
          'allowOpenAmount',
          'openAmountMin',
          'openAmountMax',
          'lifetimeDays',
        ],
        errors,
      );
      const value: Record<string, unknown> = {
        cardType,
        amounts,
        allowOpenAmount,
        lifetimeDays,
      };
      if (allowOpenAmount)
        Object.assign(value, { openAmountMin, openAmountMax });
      return { value, errors };
    }
    default:
      return Object.keys(input).length
        ? { value: {}, errors: [`${type} products have no typeOptions`] }
        : { value: {}, errors: [] };
  }
}

function unknownKeys(
  input: Record<string, unknown>,
  allowed: string[],
  errors: string[],
) {
  for (const k of Object.keys(input))
    if (!allowed.includes(k)) errors.push(`typeOptions.${k} is not supported`);
}

/** Shippable weight rules: virtual goods (and virtual gift cards) have none. */
export function weightErrors(
  type: ProductType,
  typeOptions: Record<string, unknown>,
  weightGrams: number | null | undefined,
): string[] {
  const virtual =
    type === 'VIRTUAL' ||
    (type === 'GIFT_CARD' && typeOptions.cardType !== 'PHYSICAL');
  return virtual && weightGrams != null
    ? [
        `${type === 'VIRTUAL' ? 'Virtual products' : 'Virtual gift cards'} have no weight`,
      ]
    : [];
}

/** Canonical `color=red;size=m` (sorted by attribute code). */
export function optionSignature(
  values: Readonly<Record<string, string>>,
): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join(';');
}

/** A configurable product's axes must be global SELECT attributes of its set. */
export function axisErrors(
  codes: readonly string[],
  defs: ReadonlyMap<string, AttributeDef>,
): string[] {
  const errors: string[] = [];
  if (!codes.length)
    errors.push(
      'Configurable products need at least one configurable attribute',
    );
  if (codes.length > MAX_CONFIGURABLE_AXES)
    errors.push(`At most ${MAX_CONFIGURABLE_AXES} configurable attributes`);
  if (new Set(codes).size !== codes.length)
    errors.push('Duplicate configurable attribute');
  for (const c of codes) {
    const d = defs.get(c);
    if (!d)
      errors.push(
        `Configurable attribute ${c} is not in the product's attribute set`,
      );
    else if (d.type !== 'SELECT' || d.isLocalizable)
      errors.push(
        `Configurable attribute ${c} must be a non-localizable SELECT`,
      );
  }
  return errors;
}

/** A variant names exactly one valid option for every axis. */
export function validateVariantOptions(
  axes: readonly AttributeDef[],
  raw: unknown,
  path = 'options',
): { values: Record<string, string>; signature: string; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, string> = {};
  if (!isObj(raw))
    return {
      values,
      signature: '',
      errors: [`${path} must be an object of attribute code → option code`],
    };
  for (const k of Object.keys(raw))
    if (!axes.some((a) => a.code === k))
      errors.push(
        `${path}.${k} is not a configurable attribute of this product`,
      );
  for (const axis of axes) {
    const v = raw[axis.code];
    if (typeof v !== 'string' || !axis.options.some((o) => o.code === v))
      errors.push(
        `${path}.${axis.code} must be one of: ${axis.options.map((o) => o.code).join(', ')}`,
      );
    else values[axis.code] = v;
  }
  return {
    values,
    signature: errors.length ? '' : optionSignature(values),
    errors,
  };
}

/** Single-choice inputs allow at most one default selection. */
export function bundleOptionErrors(o: {
  code: string;
  inputType: string;
  selections: { variantId: string; isDefault?: boolean }[];
}): string[] {
  const errors: string[] = [];
  if (!o.selections.length)
    errors.push(`bundleOptions[${o.code}] needs at least one selection`);
  if (
    new Set(o.selections.map((s) => s.variantId)).size !== o.selections.length
  )
    errors.push(`bundleOptions[${o.code}] lists a variant twice`);
  if (
    (o.inputType === 'SELECT' || o.inputType === 'RADIO') &&
    o.selections.filter((s) => s.isDefault).length > 1
  )
    errors.push(
      `bundleOptions[${o.code}] (${o.inputType}) allows only one default selection`,
    );
  return errors;
}
