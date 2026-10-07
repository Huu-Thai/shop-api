import {
  applicableRates,
  calculateTax,
  type Destination,
  effectiveRate,
  matchZones,
} from '../tax/tax-engine.js';
import type { TaxDefinitions } from '../tax/tax.query.js';
import {
  type BookScope,
  type EntryInput,
  type PriceContext,
  rankBooks,
  resolveTiers,
} from './price-resolver.js';

export interface ComputedTier {
  minQty: number;
  net: bigint;
  gross: bigint;
  compareAtNet: bigint | null;
  compareAtGross: bigint | null;
  book: BookScope;
}

export interface TaxSetting {
  destination: Destination;
  productTaxClassId: string;
  customerTaxClassId: string;
}

/**
 * Turns price-book entries into tiers with net and gross amounts for one destination, using the
 * tax engine for both directions (inclusive books are back-calculated, net books taxed), so stored
 * gross amounts match what checkout will charge.
 */
export class PriceComputation {
  private readonly splits = new Map<string, { net: bigint; gross: bigint }>();

  constructor(
    private readonly tax: TaxDefinitions,
    private readonly books: readonly BookScope[],
    private readonly at: Date,
  ) {}

  split(
    amount: bigint,
    includesTax: boolean,
    t: TaxSetting,
  ): { net: bigint; gross: bigint } {
    const key = `${amount}|${includesTax}|${t.destination.countryCode}|${t.destination.regionCode ?? ''}|${t.productTaxClassId}|${t.customerTaxClassId}`;
    let r = this.splits.get(key);
    if (!r) {
      const res = calculateTax(
        {
          lines: [{ key: 'p', amount, productTaxClassId: t.productTaxClassId }],
          destination: t.destination,
          customerTaxClassId: t.customerTaxClassId,
          pricesIncludeTax: includesTax,
          date: this.at,
        },
        this.tax.zones,
        this.tax.rates,
      );
      r = { net: res.totals.net, gross: res.totals.gross };
      this.splits.set(key, r);
    }
    return r;
  }

  taxRate(t: TaxSetting): string {
    const zones = new Set(
      matchZones(this.tax.zones, t.destination).map((z) => z.id),
    );
    return effectiveRate(
      applicableRates(
        this.tax.rates,
        zones,
        t.productTaxClassId,
        t.customerTaxClassId,
        this.at,
      ),
    );
  }

  ranked(ctx: Omit<PriceContext, 'at'>): BookScope[] {
    return rankBooks(this.books, { ...ctx, at: this.at });
  }

  tiers(
    ctx: Omit<PriceContext, 'at'>,
    entries: readonly EntryInput[],
    t: TaxSetting,
  ): ComputedTier[] {
    const ranked = this.ranked(ctx);
    return resolveTiers(
      ranked,
      entries,
      (amount, book) => this.split(amount, book.includesTax, t).net,
    ).map((tier) => {
      const p = this.split(tier.amount, tier.book.includesTax, t);
      const c =
        tier.compareAtAmount === null
          ? null
          : this.split(tier.compareAtAmount, tier.book.includesTax, t);
      return {
        minQty: tier.minQty,
        net: p.net,
        gross: p.gross,
        compareAtNet: c?.net ?? null,
        compareAtGross: c?.gross ?? null,
        book: tier.book,
      };
    });
  }
}
