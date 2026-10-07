import { distribute, Fraction } from './fraction.js';

export interface TaxZoneDef {
  id: string;
  code: string;
  rounding: 'LINE' | 'TOTAL';
  regions: {
    countryCode: string;
    regionCode: string | null;
    postcodePattern: string | null;
  }[];
}

export interface TaxRateDef {
  id: string;
  zoneId: string;
  productTaxClassId: string;
  /** null = every customer class */
  customerTaxClassId: string | null;
  name: string;
  /** Percent with up to 4 decimals, e.g. `'19.0000'`. */
  rate: string;
  priority: number;
  isCompound: boolean;
  validFrom: Date;
  validTo: Date | null;
}

export interface Destination {
  countryCode: string;
  regionCode?: string | null;
  postcode?: string | null;
}

export interface TaxLineInput {
  key: string;
  /** Line amount in minor units (unit price × qty, after discounts). */
  amount: bigint;
  productTaxClassId: string;
}

export interface TaxRequest {
  lines: TaxLineInput[];
  destination: Destination;
  customerTaxClassId: string;
  /** Amounts are tax-inclusive (gross) or net. */
  pricesIncludeTax: boolean;
  /** Effective date (order date): rates valid on that day apply. */
  date: Date;
}

export interface AppliedTax {
  rateId: string;
  name: string;
  rate: string;
  amount: bigint;
}

export interface TaxLineResult {
  key: string;
  net: bigint;
  tax: bigint;
  gross: bigint;
  taxes: AppliedTax[];
}

export interface TaxResult {
  lines: TaxLineResult[];
  totals: { net: bigint; tax: bigint; gross: bigint };
  /** Tax per rate over all lines (for invoices). */
  taxes: AppliedTax[];
  zones: string[];
  rounding: 'LINE' | 'TOTAL';
}

const normPostcode = (p: string) => p.toUpperCase().replace(/[\s-]/g, '');

/** `900*` style patterns; `*` matches any run of characters. */
export function postcodeMatches(pattern: string, postcode: string): boolean {
  const re = new RegExp(
    `^${normPostcode(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
  );
  return re.test(normPostcode(postcode));
}

/** Every zone with a region matching the destination (state + county zones both apply). */
export function matchZones(
  zones: readonly TaxZoneDef[],
  d: Destination,
): TaxZoneDef[] {
  return zones.filter((z) =>
    z.regions.some(
      (r) =>
        r.countryCode === d.countryCode.toUpperCase() &&
        (!r.regionCode ||
          r.regionCode.toUpperCase() === (d.regionCode ?? '').toUpperCase()) &&
        (!r.postcodePattern ||
          (!!d.postcode && postcodeMatches(r.postcodePattern, d.postcode))),
    ),
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Rates for one product class, ordered by priority (then id, for determinism). */
export function applicableRates(
  rates: readonly TaxRateDef[],
  zoneIds: ReadonlySet<string>,
  productTaxClassId: string,
  customerTaxClassId: string,
  date: Date,
): TaxRateDef[] {
  const today = day(date);
  return rates
    .filter(
      (r) =>
        zoneIds.has(r.zoneId) &&
        r.productTaxClassId === productTaxClassId &&
        (r.customerTaxClassId === null ||
          r.customerTaxClassId === customerTaxClassId) &&
        day(r.validFrom) <= today &&
        (!r.validTo || today < day(r.validTo)),
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * Tax of each rate as a fraction of the net amount: non-compound rates apply to net; compound rates
 * to net + the taxes of lower priorities. Rates of the same priority never compound on each other.
 */
export function rateFactors(rates: readonly TaxRateDef[]): Fraction[] {
  const factors: Fraction[] = [];
  let lowerPriorities = Fraction.of(0);
  let groupSum = Fraction.of(0);
  let group: number | undefined;
  for (const r of rates) {
    if (group !== r.priority) {
      lowerPriorities = lowerPriorities.add(groupSum);
      groupSum = Fraction.of(0);
      group = r.priority;
    }
    const base = r.isCompound
      ? Fraction.of(1).add(lowerPriorities)
      : Fraction.of(1);
    const f = base.mul(Fraction.percent(r.rate));
    factors.push(f);
    groupSum = groupSum.add(f);
  }
  return factors;
}

/** Total effective rate (e.g. 9.5000 for 7.25% + 2.25%). */
export function effectiveRate(rates: readonly TaxRateDef[]): string {
  return rateFactors(rates)
    .reduce((a, b) => a.add(b), Fraction.of(0))
    .toPercent();
}

interface ExactLine {
  key: string;
  amount: bigint;
  rates: TaxRateDef[];
  /** Exact tax per rate. */
  exact: Fraction[];
}

/**
 * Multi-country tax (PLAN.md §9.7). Exclusive prices: tax = net × rate, gross = net + tax.
 * Inclusive prices: gross is kept exactly as entered; net = gross ÷ (1 + effective rate) and the
 * tax is the difference, split over the rates. LINE rounding rounds each line; TOTAL rounds each
 * rate's total and distributes it over the lines (largest remainder), so lines add up exactly.
 */
export function calculateTax(
  req: TaxRequest,
  zones: readonly TaxZoneDef[],
  rates: readonly TaxRateDef[],
): TaxResult {
  const matched = matchZones(zones, req.destination);
  const zoneIds = new Set(matched.map((z) => z.id));
  const rounding: 'LINE' | 'TOTAL' =
    matched.length && matched.every((z) => z.rounding === 'TOTAL')
      ? 'TOTAL'
      : 'LINE';

  const exact: ExactLine[] = req.lines.map((l) => {
    const lineRates = applicableRates(
      rates,
      zoneIds,
      l.productTaxClassId,
      req.customerTaxClassId,
      req.date,
    );
    const factors = rateFactors(lineRates);
    const k = factors.reduce((a, b) => a.add(b), Fraction.of(0));
    const amount = Fraction.of(l.amount);
    const net = req.pricesIncludeTax
      ? amount.div(Fraction.of(1).add(k))
      : amount;
    return {
      key: l.key,
      amount: l.amount,
      rates: lineRates,
      exact: factors.map((f) => net.mul(f)),
    };
  });

  // Rounded tax per line and rate.
  const rounded: bigint[][] = exact.map(() => []);
  if (rounding === 'LINE') {
    exact.forEach((l, i) => {
      const total = l.exact.reduce((a, b) => a.add(b), Fraction.of(0)).round();
      // Rates of a line share its rounded total, so line tax never drifts from the line total.
      rounded[i] = l.exact.length ? distribute(total, l.exact) : [];
    });
  } else {
    const byRate = new Map<
      string,
      {
        rate: TaxRateDef;
        cells: { line: number; idx: number; exact: Fraction }[];
      }
    >();
    exact.forEach((l, line) =>
      l.rates.forEach((rate, idx) => {
        const e = byRate.get(rate.id) ?? { rate, cells: [] };
        e.cells.push({ line, idx, exact: l.exact[idx] });
        byRate.set(rate.id, e);
      }),
    );
    exact.forEach((l, i) => (rounded[i] = l.rates.map(() => 0n)));
    for (const { cells } of byRate.values()) {
      const total = cells
        .reduce((a, c) => a.add(c.exact), Fraction.of(0))
        .round();
      distribute(
        total,
        cells.map((c) => c.exact),
      ).forEach((amount, j) => (rounded[cells[j].line][cells[j].idx] = amount));
    }
  }

  const lines: TaxLineResult[] = exact.map((l, i) => {
    const tax = rounded[i].reduce((a, b) => a + b, 0n);
    const net = req.pricesIncludeTax ? l.amount - tax : l.amount;
    return {
      key: l.key,
      net,
      tax,
      gross: net + tax,
      taxes: l.rates.map((r, j) => ({
        rateId: r.id,
        name: r.name,
        rate: Fraction.percent(r.rate).toPercent(),
        amount: rounded[i][j],
      })),
    };
  });
  const summary = new Map<string, AppliedTax>();
  for (const t of lines.flatMap((l) => l.taxes)) {
    const s = summary.get(t.rateId);
    if (s) s.amount += t.amount;
    else summary.set(t.rateId, { ...t });
  }
  return {
    lines,
    totals: {
      net: lines.reduce((a, l) => a + l.net, 0n),
      tax: lines.reduce((a, l) => a + l.tax, 0n),
      gross: lines.reduce((a, l) => a + l.gross, 0n),
    },
    taxes: [...summary.values()],
    zones: matched.map((z) => z.code),
    rounding,
  };
}
