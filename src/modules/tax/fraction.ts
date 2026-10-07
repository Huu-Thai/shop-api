/** Exact non-floating arithmetic for money and rates (BigInt numerator / positive denominator). */
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den = 1n) {
    if (den === 0n) throw new RangeError('Division by zero');
    const sign = den < 0n ? -1n : 1n;
    const g = gcd(num < 0n ? -num : num, den < 0n ? -den : den) || 1n;
    this.num = (sign * num) / g;
    this.den = (sign * den) / g;
  }

  static of(n: bigint | number): Fraction {
    return new Fraction(BigInt(n));
  }

  /** `'19.0000'` → 19/100 (a percent string as a ratio). */
  static percent(p: string | number): Fraction {
    const [int, dec = ''] = String(p).split('.');
    const scale = 10n ** BigInt(dec.length);
    return new Fraction(BigInt(int + dec), scale * 100n);
  }

  add(o: Fraction): Fraction {
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Fraction): Fraction {
    return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Fraction): Fraction {
    return new Fraction(this.num * o.num, this.den * o.den);
  }
  div(o: Fraction): Fraction {
    return new Fraction(this.num * o.den, this.den * o.num);
  }

  /** Half away from zero (commercial rounding). */
  round(): bigint {
    const neg = this.num < 0n;
    const n = neg ? -this.num : this.num;
    const q = (2n * n + this.den) / (2n * this.den);
    return neg ? -q : q;
  }

  floor(): bigint {
    const q = this.num / this.den;
    return this.num < 0n && q * this.den !== this.num ? q - 1n : q;
  }

  /** Percent with 4 decimals, e.g. `9.5000`. */
  toPercent(): string {
    const scaled = this.mul(Fraction.of(1_000_000n)).round(); // percent × 10^4
    const neg = scaled < 0n;
    const s = (neg ? -scaled : scaled).toString().padStart(5, '0');
    return `${neg ? '-' : ''}${s.slice(0, -4)}.${s.slice(-4)}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Splits `total` (already rounded) over parts proportional to exact `shares`, so the rounded parts
 * add up exactly (largest remainder method; ties go to the earlier part).
 */
export function distribute(
  total: bigint,
  shares: readonly Fraction[],
): bigint[] {
  const sum = shares.reduce((a, b) => a.add(b), Fraction.of(0));
  if (sum.num === 0n)
    return shares.map((_, i) => (i === shares.length - 1 ? total : 0n));
  const exact = shares.map((s) => s.div(sum).mul(Fraction.of(total)));
  const parts = exact.map((e) => e.floor());
  let left = total - parts.reduce((a, b) => a + b, 0n);
  const order = exact
    .map((e, i) => ({ i, rem: e.sub(Fraction.of(parts[i])) }))
    .sort((a, b) =>
      b.rem.sub(a.rem).num > 0n
        ? 1
        : b.rem.sub(a.rem).num < 0n
          ? -1
          : a.i - b.i,
    );
  for (const { i } of order) {
    if (left <= 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts;
}
