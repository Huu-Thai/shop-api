import { distribute, Fraction } from './fraction.js';
import {
  calculateTax,
  effectiveRate,
  matchZones,
  postcodeMatches,
  type TaxRateDef,
  type TaxRequest,
  type TaxZoneDef,
} from './tax-engine.js';

const zone = (
  id: string,
  regions: TaxZoneDef['regions'],
  rounding: 'LINE' | 'TOTAL' = 'LINE',
): TaxZoneDef => ({ id, code: id, rounding, regions });
const region = (
  countryCode: string,
  regionCode: string | null = null,
  postcodePattern: string | null = null,
) => ({ countryCode, regionCode, postcodePattern });
let n = 0;
const rate = (
  zoneId: string,
  cls: string,
  pct: string,
  o: Partial<TaxRateDef> = {},
): TaxRateDef => ({
  id: `r${String(++n).padStart(3, '0')}`,
  zoneId,
  productTaxClassId: cls,
  customerTaxClassId: null,
  name: `${zoneId} ${pct}%`,
  rate: pct,
  priority: 0,
  isCompound: false,
  validFrom: new Date('1970-01-01'),
  validTo: null,
  ...o,
});

const ZONES = [
  zone('DE', [region('DE')]),
  zone('VN', [region('VN')]),
  zone('US-CA', [region('US', 'CA')]),
  zone('US-CA-LA', [region('US', 'CA', '900*'), region('US', 'CA', '901*')]),
  zone('CA-QC', [region('CA', 'QC')]),
  zone('NL', [region('NL')], 'TOTAL'),
];
const RATES = [
  rate('DE', 'standard', '19.0000', { customerTaxClassId: 'retail' }),
  rate('DE', 'reduced', '7.0000'),
  rate('VN', 'standard', '10.0000'),
  rate('VN', 'reduced', '5.0000', { validTo: new Date('2024-01-01') }),
  rate('VN', 'reduced', '8.0000', { validFrom: new Date('2024-01-01') }),
  rate('US-CA', 'standard', '7.2500'),
  rate('US-CA-LA', 'standard', '2.2500'),
  rate('CA-QC', 'standard', '5.0000', { name: 'GST' }),
  rate('CA-QC', 'standard', '9.5000', {
    name: 'QST',
    priority: 1,
    isCompound: true,
  }),
  rate('NL', 'standard', '10.0000'),
];

const req = (
  amounts: number[],
  o: Partial<TaxRequest> & {
    country: string;
    region?: string;
    postcode?: string;
    cls?: string;
  },
): TaxRequest => ({
  lines: amounts.map((a, i) => ({
    key: `l${i}`,
    amount: BigInt(a),
    productTaxClassId: o.cls ?? 'standard',
  })),
  destination: {
    countryCode: o.country,
    regionCode: o.region,
    postcode: o.postcode,
  },
  customerTaxClassId: o.customerTaxClassId ?? 'retail',
  pricesIncludeTax: o.pricesIncludeTax ?? false,
  date: o.date ?? new Date('2026-10-17'),
});
const totals = (r: ReturnType<typeof calculateTax>) => [
  Number(r.totals.net),
  Number(r.totals.tax),
  Number(r.totals.gross),
];

describe('calculateTax — country fixtures', () => {
  it.each([
    // [label, request, net, tax, gross]
    [
      'DE inclusive 119.00 €',
      req([11900], { country: 'DE', pricesIncludeTax: true }),
      10000,
      1900,
      11900,
    ],
    [
      'DE inclusive 9.99 € keeps the gross exact',
      req([999], { country: 'DE', pricesIncludeTax: true }),
      839,
      160,
      999,
    ],
    [
      'DE reduced 7 %',
      req([1070], { country: 'DE', cls: 'reduced', pricesIncludeTax: true }),
      1000,
      70,
      1070,
    ],
    [
      'DE B2B: retail-only rate does not apply',
      req([10000], { country: 'DE', customerTaxClassId: 'business' }),
      10000,
      0,
      10000,
    ],
    [
      'VN inclusive VND (0 decimals)',
      req([250000], { country: 'VN', pricesIncludeTax: true }),
      227273,
      22727,
      250000,
    ],
    [
      'VN reduced rate after 2024 (8 %)',
      req([108000], { country: 'VN', cls: 'reduced', pricesIncludeTax: true }),
      100000,
      8000,
      108000,
    ],
    [
      'VN reduced rate in 2023 (5 %)',
      req([105000], {
        country: 'VN',
        cls: 'reduced',
        pricesIncludeTax: true,
        date: new Date('2023-06-01'),
      }),
      100000,
      5000,
      105000,
    ],
    [
      'US-CA Los Angeles: state + county stack',
      req([10000], { country: 'US', region: 'CA', postcode: '90012' }),
      10000,
      950,
      10950,
    ],
    [
      'US-CA San Francisco: state only',
      req([10000], { country: 'US', region: 'ca', postcode: '94103' }),
      10000,
      725,
      10725,
    ],
    [
      'US-NY: no rates',
      req([10000], { country: 'US', region: 'NY', postcode: '10001' }),
      10000,
      0,
      10000,
    ],
    [
      'CA-QC compound QST on GST',
      req([10000], { country: 'CA', region: 'QC' }),
      10000,
      1498,
      11498,
    ],
    [
      'zero-rated class',
      req([5000], { country: 'DE', cls: 'zero', pricesIncludeTax: true }),
      5000,
      0,
      5000,
    ],
  ])('%s', (_label, request, net, tax, gross) => {
    expect(totals(calculateTax(request, ZONES, RATES))).toEqual([
      net,
      tax,
      gross,
    ]);
  });

  it('itemises stacked and compound rates per line and in the summary', () => {
    const r = calculateTax(
      req([10000], { country: 'CA', region: 'QC' }),
      ZONES,
      RATES,
    );
    expect(
      r.lines[0].taxes.map((t) => [t.name, t.rate, Number(t.amount)]),
    ).toEqual([
      ['GST', '5.0000', 500],
      ['QST', '9.5000', 998],
    ]);
    expect(r.zones).toEqual(['CA-QC']);
    const la = calculateTax(
      req([10000, 2000], { country: 'US', region: 'CA', postcode: '901-23' }),
      ZONES,
      RATES,
    );
    expect(la.zones).toEqual(['US-CA', 'US-CA-LA']);
    expect(la.taxes.map((t) => Number(t.amount))).toEqual([870, 270]);
  });

  it('LINE vs TOTAL rounding', () => {
    const line = calculateTax(
      req([333, 333, 333], { country: 'VN' }),
      ZONES,
      RATES,
    );
    expect(line.lines.map((l) => Number(l.tax))).toEqual([33, 33, 33]);
    expect(line.rounding).toBe('LINE');
    const total = calculateTax(
      req([333, 333, 333], { country: 'NL' }),
      ZONES,
      RATES,
    );
    expect(total.rounding).toBe('TOTAL');
    expect(total.lines.map((l) => Number(l.tax))).toEqual([34, 33, 33]);
    expect(Number(total.totals.tax)).toBe(100);
  });

  it('inclusive TOTAL rounding keeps every gross exact', () => {
    const r = calculateTax(
      req([999, 999, 1], { country: 'NL', pricesIncludeTax: true }),
      ZONES,
      RATES,
    );
    expect(r.lines.map((l) => Number(l.gross))).toEqual([999, 999, 1]);
    expect(Number(r.totals.tax)).toBe(Math.round((1999 / 1.1) * 0.1));
  });

  it('no matching zone means no tax', () => {
    expect(
      totals(calculateTax(req([100], { country: 'JP' }), ZONES, RATES)),
    ).toEqual([100, 0, 100]);
  });
});

describe('zones and rates', () => {
  it('matches country, region and postcode patterns', () => {
    expect(postcodeMatches('900*', '90012')).toBe(true);
    expect(postcodeMatches('SW1A *', 'sw1a 1aa')).toBe(true);
    expect(postcodeMatches('900*', '91012')).toBe(false);
    expect(postcodeMatches('a.b', 'axb')).toBe(false);
    expect(
      matchZones(ZONES, { countryCode: 'us', regionCode: 'CA' }).map(
        (z) => z.code,
      ),
    ).toEqual(['US-CA']);
  });

  it('computes the effective rate including compounding', () => {
    const qc = RATES.filter((r) => r.zoneId === 'CA-QC');
    expect(effectiveRate(qc)).toBe('14.9750');
    expect(effectiveRate([])).toBe('0.0000');
  });
});

describe('Fraction & distribute', () => {
  it('rounds half away from zero and floors', () => {
    expect(new Fraction(5n, 2n).round()).toBe(3n);
    expect(new Fraction(-5n, 2n).round()).toBe(-3n);
    expect(new Fraction(-5n, 2n).floor()).toBe(-3n);
    expect(new Fraction(7n, -2n).num).toBe(-7n);
    expect(Fraction.percent('7.25').toPercent()).toBe('7.2500');
    expect(Fraction.percent(19).sub(Fraction.percent(20)).toPercent()).toBe(
      '-1.0000',
    );
    expect(() => new Fraction(1n, 0n)).toThrow(RangeError);
  });

  it('splits totals exactly by largest remainder', () => {
    const third = new Fraction(1n, 3n);
    expect(distribute(100n, [third, third, third])).toEqual([34n, 33n, 33n]);
    expect(distribute(10n, [Fraction.of(0), Fraction.of(0)])).toEqual([
      0n,
      10n,
    ]);
    expect(distribute(0n, [])).toEqual([]);
  });
});
