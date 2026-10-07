import {
  type AttributeDef,
  mergeValues,
  normalizeValue,
  validateAttributes,
} from './attribute-values.js';

const def = (
  code: string,
  type: AttributeDef['type'],
  o: Partial<AttributeDef> = {},
): AttributeDef => ({
  id: code,
  code,
  type,
  isRequired: false,
  isLocalizable: false,
  isFilterable: false,
  isSearchable: false,
  isVisible: true,
  position: 0,
  options: ['red', 'blue'].map((c, position) => ({
    code: c,
    swatch: null,
    position,
  })),
  ...o,
});

describe('normalizeValue', () => {
  it.each([
    ['TEXT', '  Cotton ', 'Cotton'],
    ['INTEGER', 3, 3],
    ['DECIMAL', '2.50', 2.5],
    ['DECIMAL', 1.25, 1.25],
    ['BOOLEAN', false, false],
    ['DATE', '2026-02-28', '2026-02-28'],
    ['SELECT', 'red', 'red'],
    ['MULTISELECT', ['red', 'blue', 'red'], ['red', 'blue']],
  ] as const)('%s accepts %j', (type, input, out) => {
    expect(normalizeValue(def('a', type), input)).toEqual({ value: out });
  });

  it.each([
    ['TEXT', ''],
    ['TEXT', 'x'.repeat(256)],
    ['INTEGER', 1.5],
    ['INTEGER', '3'],
    ['DECIMAL', 'abc'],
    ['DECIMAL', Infinity],
    ['BOOLEAN', 'true'],
    ['DATE', '2026-02-30'],
    ['DATE', '26-1-1'],
    ['SELECT', 'green'],
    ['MULTISELECT', []],
    ['MULTISELECT', ['red', 'green']],
  ] as const)('%s rejects %j', (type, input) => {
    expect(normalizeValue(def('a', type), input)).toHaveProperty('error');
  });
});

describe('mergeValues', () => {
  it('merges and removes keys set to null', () => {
    expect(mergeValues({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({
      a: 1,
      c: 3,
    });
    expect(mergeValues({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe('validateAttributes', () => {
  const defs = new Map(
    [
      def('material', 'TEXT', { isRequired: true }),
      def('color', 'SELECT', { isRequired: true }),
      def('care', 'TEXTAREA', { isLocalizable: true, isRequired: true }),
    ].map((d) => [d.code, d]),
  );

  it('normalises valid values', () => {
    expect(
      validateAttributes(
        defs,
        { material: ' Cotton ', color: 'red' },
        { localizable: false, requireAll: true },
      ),
    ).toEqual({
      values: { material: 'Cotton', color: 'red' },
      errors: [],
    });
  });

  it('reports every problem with a path', () => {
    const { errors } = validateAttributes(
      defs,
      { weight: 1, care: 'x', color: 'pink' },
      { localizable: false, requireAll: true, path: 'p.' },
    );
    expect(errors).toEqual([
      "p.attributes.weight is not in the product's attribute set",
      'p.attributes.care is localizable; set it in the translations',
      expect.stringContaining('p.attributes.color must be one of'),
      'p.attributes.material is required',
      'p.attributes.color is required',
    ]);
  });

  it('keeps variant axes off the product and does not require them', () => {
    const r = validateAttributes(
      defs,
      { color: 'red', material: 'Wool' },
      { localizable: false, requireAll: true, exclude: new Set(['color']) },
    );
    expect(r.errors).toEqual([
      'attributes.color is a variant option of this product; set it on the variants',
    ]);
  });

  it('checks localizable values separately', () => {
    expect(
      validateAttributes(
        defs,
        { material: 'x' },
        { localizable: true, requireAll: true },
      ).errors,
    ).toEqual([
      'attributes.material is not localizable; set it on the product',
      'attributes.care is required',
    ]);
  });
});
