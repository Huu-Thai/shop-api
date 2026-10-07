import type { AttributeType } from '../../database/generated/prisma/client.js';

export interface AttributeDef {
  id: string;
  code: string;
  type: AttributeType;
  isRequired: boolean;
  isLocalizable: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  isVisible: boolean;
  position: number;
  options: { code: string; swatch: string | null; position: number }[];
}

export type AttributeValues = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = { TEXT: 255, TEXTAREA: 65_535 } as const;

/** Normalises one value for its definition, or returns an error message. */
export function normalizeValue(
  def: AttributeDef,
  value: unknown,
): { value: unknown } | { error: string } {
  const bad = (expected: string) => ({
    error: `attributes.${def.code} must be ${expected}`,
  });
  switch (def.type) {
    case 'TEXT':
    case 'TEXTAREA': {
      if (typeof value !== 'string') return bad('a string');
      const v = value.trim();
      if (!v) return bad('a non-empty string');
      return v.length > MAX[def.type]
        ? bad(`at most ${MAX[def.type]} characters`)
        : { value: v };
    }
    case 'INTEGER':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? { value }
        : bad('an integer');
    case 'DECIMAL': {
      const n =
        typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : value;
      return typeof n === 'number' && Number.isFinite(n)
        ? { value: n }
        : bad('a number');
    }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? { value } : bad('true or false');
    case 'DATE': {
      if (typeof value !== 'string' || !DATE.test(value))
        return bad('a date (YYYY-MM-DD)');
      const d = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
        ? { value }
        : bad('a valid date');
    }
    case 'SELECT':
      return typeof value === 'string' &&
        def.options.some((o) => o.code === value)
        ? { value }
        : bad(`one of: ${def.options.map((o) => o.code).join(', ')}`);
    case 'MULTISELECT': {
      if (!Array.isArray(value) || !value.length)
        return bad('a non-empty list of option codes');
      const unknown = value.filter(
        (v) => typeof v !== 'string' || !def.options.some((o) => o.code === v),
      );
      if (unknown.length)
        return bad(`a list of: ${def.options.map((o) => o.code).join(', ')}`);
      return { value: [...new Set(value as string[])] };
    }
  }
}

/** RFC 7386-style merge: `null` removes a key. */
export function mergeValues(
  current: AttributeValues,
  patch: AttributeValues | undefined,
): AttributeValues {
  if (!patch) return { ...current };
  const out: AttributeValues = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export interface ValidateOptions {
  /** Validate the localizable (translation) or the global attribute values. */
  localizable: boolean;
  /** Codes that must not be given here (a configurable product's variant axes). */
  exclude?: ReadonlySet<string>;
  /** Check that every required attribute (of this kind) is present. */
  requireAll?: boolean;
  /** Prefix for error paths, e.g. `translations[vi-VN].` */
  path?: string;
}

/**
 * Validates attribute values against the attribute set's definitions. Returns normalised values and
 * every problem at once (400 body), never throws.
 */
export function validateAttributes(
  defs: ReadonlyMap<string, AttributeDef>,
  values: AttributeValues,
  opts: ValidateOptions,
): { values: AttributeValues; errors: string[] } {
  const errors: string[] = [];
  const out: AttributeValues = {};
  const p = opts.path ?? '';
  for (const [code, raw] of Object.entries(values)) {
    const def = defs.get(code);
    if (!def) {
      errors.push(
        `${p}attributes.${code} is not in the product's attribute set`,
      );
      continue;
    }
    if (def.isLocalizable !== opts.localizable) {
      errors.push(
        def.isLocalizable
          ? `${p}attributes.${code} is localizable; set it in the translations`
          : `${p}attributes.${code} is not localizable; set it on the product`,
      );
      continue;
    }
    if (opts.exclude?.has(code)) {
      errors.push(
        `${p}attributes.${code} is a variant option of this product; set it on the variants`,
      );
      continue;
    }
    const r = normalizeValue(def, raw);
    if ('error' in r) errors.push(`${p}${r.error}`);
    else out[code] = r.value;
  }
  if (opts.requireAll)
    for (const def of defs.values())
      if (
        def.isRequired &&
        def.isLocalizable === opts.localizable &&
        !opts.exclude?.has(def.code) &&
        !(def.code in out)
      )
        errors.push(`${p}attributes.${def.code} is required`);
  return { values: out, errors };
}
