import type { AttributeDef } from '../catalog/attribute-values.js';
import {
  axisErrors,
  bundleOptionErrors,
  optionSignature,
  validateTypeOptions,
  validateVariantOptions,
  weightErrors,
} from './product-types.js';

const sel = (
  code: string,
  options: string[],
  o: Partial<AttributeDef> = {},
): AttributeDef => ({
  id: code,
  code,
  type: 'SELECT',
  isRequired: false,
  isLocalizable: false,
  isFilterable: true,
  isSearchable: false,
  isVisible: true,
  position: 0,
  options: options.map((c, position) => ({ code: c, swatch: null, position })),
  ...o,
});

describe('validateTypeOptions', () => {
  it('fills bundle defaults and rejects unknown values', () => {
    expect(validateTypeOptions('BUNDLE', undefined)).toEqual({
      value: { priceType: 'DYNAMIC', shipmentType: 'TOGETHER' },
      errors: [],
    });
    expect(
      validateTypeOptions('BUNDLE', { priceType: 'CHEAP', extra: 1 }).errors,
    ).toEqual([
      'typeOptions.priceType must be DYNAMIC or FIXED',
      'typeOptions.extra is not supported',
    ]);
  });

  it('validates gift card amounts and open amounts', () => {
    const ok = validateTypeOptions('GIFT_CARD', {
      amounts: [{ currency: 'USD', amount: 2500 }],
    });
    expect(ok).toEqual({
      value: {
        cardType: 'VIRTUAL',
        amounts: [{ currency: 'USD', amount: 2500 }],
        allowOpenAmount: false,
        lifetimeDays: null,
      },
      errors: [],
    });
    expect(validateTypeOptions('GIFT_CARD', {}).errors).toEqual([
      'A gift card needs preset amounts or an open amount',
    ]);
    expect(
      validateTypeOptions('GIFT_CARD', {
        allowOpenAmount: true,
        openAmountMin: 5000,
        openAmountMax: 1000,
      }).errors,
    ).toHaveLength(1);
    expect(
      validateTypeOptions('GIFT_CARD', {
        allowOpenAmount: true,
        openAmountMin: 1000,
        openAmountMax: 50000,
        lifetimeDays: 365,
      }).value,
    ).toMatchObject({
      openAmountMin: 1000,
      lifetimeDays: 365,
    });
    expect(
      validateTypeOptions('GIFT_CARD', {
        amounts: [{ currency: 'usd', amount: 1.5 }],
      }).errors[0],
    ).toContain('typeOptions.amounts');
  });

  it('other types take no options', () => {
    expect(validateTypeOptions('SIMPLE', {})).toEqual({
      value: {},
      errors: [],
    });
    expect(validateTypeOptions('SIMPLE', { x: 1 }).errors).toEqual([
      'SIMPLE products have no typeOptions',
    ]);
    expect(validateTypeOptions('SIMPLE', [1]).errors).toEqual([
      'typeOptions must be an object',
    ]);
  });
});

it('virtual goods have no weight', () => {
  expect(weightErrors('VIRTUAL', {}, 100)).toHaveLength(1);
  expect(weightErrors('GIFT_CARD', { cardType: 'VIRTUAL' }, 5)).toHaveLength(1);
  expect(weightErrors('GIFT_CARD', { cardType: 'PHYSICAL' }, 5)).toEqual([]);
  expect(weightErrors('SIMPLE', {}, 200)).toEqual([]);
});

describe('configurable variants', () => {
  const color = sel('color', ['red', 'blue']);
  const size = sel('size', ['s', 'm']);
  const defs = new Map(
    [
      color,
      size,
      sel('care', [], { type: 'TEXT' }),
      sel('season', ['x'], { isLocalizable: true }),
    ].map((d) => [d.code, d]),
  );

  it('signs option values canonically', () => {
    expect(optionSignature({ size: 'm', color: 'red' })).toBe(
      'color=red;size=m',
    );
  });

  it('checks the axes', () => {
    expect(axisErrors(['color', 'size'], defs)).toEqual([]);
    expect(axisErrors([], defs)).toHaveLength(1);
    expect(
      axisErrors(['color', 'color', 'care', 'season', 'nope'], defs),
    ).toEqual([
      'Duplicate configurable attribute',
      'Configurable attribute care must be a non-localizable SELECT',
      'Configurable attribute season must be a non-localizable SELECT',
      "Configurable attribute nope is not in the product's attribute set",
    ]);
  });

  it('requires one valid option per axis', () => {
    expect(
      validateVariantOptions([color, size], { color: 'red', size: 'm' }),
    ).toEqual({
      values: { color: 'red', size: 'm' },
      signature: 'color=red;size=m',
      errors: [],
    });
    expect(
      validateVariantOptions(
        [color, size],
        { color: 'green', fit: 'slim' },
        'v[0].options',
      ).errors,
    ).toEqual([
      'v[0].options.fit is not a configurable attribute of this product',
      'v[0].options.color must be one of: red, blue',
      'v[0].options.size must be one of: s, m',
    ]);
    expect(validateVariantOptions([color], 'red').errors).toHaveLength(1);
  });
});

it('bundle options: selections, duplicates and single defaults', () => {
  expect(
    bundleOptionErrors({ code: 'top', inputType: 'RADIO', selections: [] }),
  ).toEqual(['bundleOptions[top] needs at least one selection']);
  expect(
    bundleOptionErrors({
      code: 'top',
      inputType: 'SELECT',
      selections: [
        { variantId: 'a', isDefault: true },
        { variantId: 'a', isDefault: true },
      ],
    }),
  ).toHaveLength(2);
  expect(
    bundleOptionErrors({
      code: 'x',
      inputType: 'CHECKBOX',
      selections: [
        { variantId: 'a', isDefault: true },
        { variantId: 'b', isDefault: true },
      ],
    }),
  ).toEqual([]);
});
