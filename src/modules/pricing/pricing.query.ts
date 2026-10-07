import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { GUEST_GROUP } from '../customers/customers.events.js';
import { CustomersQuery } from '../customers/customers.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { StoresQuery } from '../stores/stores.query.js';
import { Fraction } from '../tax/fraction.js';
import { convertMinor, decimal, formatMoney } from './money.js';

export interface PriceView {
  currency: string;
  /** What to show: gross when the store displays prices tax-inclusive, else net. */
  amount: number;
  net: number;
  gross: number;
  includesTax: boolean;
  taxRate: string;
  formatted: string;
  compareAt: number | null;
  compareAtFormatted: string | null;
  tiers: { minQty: number; amount: number; formatted: string }[];
  /** Converted from the store's default currency with the latest exchange rate. */
  converted: boolean;
}

interface IndexRow {
  variantId: string;
  minQty: number;
  netAmount: bigint;
  grossAmount: bigint;
  compareAtNet: bigint | null;
  compareAtGross: bigint | null;
  taxRate: { toFixed(n: number): string };
}

/** Storefront prices from the price index, in the request currency (PLAN.md §7.1 price objects). */
@Injectable()
export class PricingQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
    private readonly customers: CustomersQuery,
  ) {}

  async prices(
    ctx: StoreContext,
    variantIds: readonly string[],
    // Signed-in shoppers see their group's prices; visitors the guest group's.
    groupCode = ctx.customer?.groupCode ?? GUEST_GROUP,
  ): Promise<Map<string, PriceView>> {
    const out = new Map<string, PriceView>();
    if (!variantIds.length) return out;
    const [snap, group] = await Promise.all([
      this.stores.snapshot(),
      this.customers.groupByCode(groupCode),
    ]);
    const store = snap.byId.get(ctx.storeId)!;
    const minor = (c: string) => snap.currencies.get(c)?.minorUnits ?? 2;
    const load = (currencyCode: string, ids: readonly string[]) =>
      this.prisma.priceIndex.findMany({
        where: {
          storeId: ctx.storeId,
          customerGroupId: group.id,
          currencyCode,
          variantId: { in: [...ids] },
        },
        orderBy: { minQty: 'asc' },
      }) as Promise<IndexRow[]>;

    const build = (
      rows: IndexRow[],
      currency: string,
      convert?: (a: bigint) => bigint,
    ) => {
      const c = convert ?? ((a: bigint) => a);
      const shown = (r: IndexRow) =>
        c(store.pricesIncludeTax ? r.grossAmount : r.netAmount);
      const fmt = (a: number) =>
        formatMoney(a, currency, minor(currency), ctx.localeCode);
      for (const variantId of new Set(rows.map((r) => r.variantId))) {
        const tiers = rows.filter((r) => r.variantId === variantId);
        const base = tiers[0];
        const amount = Number(shown(base));
        const cmp = store.pricesIncludeTax
          ? base.compareAtGross
          : base.compareAtNet;
        const compareAt = cmp === null ? null : Number(c(cmp));
        out.set(variantId, {
          currency,
          amount,
          net: Number(c(base.netAmount)),
          gross: Number(c(base.grossAmount)),
          includesTax: store.pricesIncludeTax,
          taxRate: base.taxRate.toFixed(4),
          formatted: fmt(amount),
          compareAt,
          compareAtFormatted: compareAt === null ? null : fmt(compareAt),
          tiers: tiers.slice(1).map((t) => ({
            minQty: t.minQty,
            amount: Number(shown(t)),
            formatted: fmt(Number(shown(t))),
          })),
          converted: !!convert,
        });
      }
    };

    build(await load(ctx.currencyCode, variantIds), ctx.currencyCode);
    const missing = variantIds.filter((id) => !out.has(id));
    if (missing.length && ctx.currencyCode !== store.defaultCurrencyCode) {
      const rate = await this.rate(store.defaultCurrencyCode, ctx.currencyCode);
      if (rate)
        build(
          await load(store.defaultCurrencyCode, missing),
          ctx.currencyCode,
          (a) =>
            convertMinor(
              a,
              rate,
              minor(store.defaultCurrencyCode),
              minor(ctx.currencyCode),
            ),
        );
    }
    return out;
  }

  /** Money formatter for the request locale (minor units from the currency table). */
  async formatter(
    ctx: StoreContext,
  ): Promise<(amount: number, currency: string) => string> {
    const snap = await this.stores.snapshot();
    return (amount, currency) =>
      formatMoney(
        amount,
        currency,
        snap.currencies.get(currency)?.minorUnits ?? 2,
        ctx.localeCode,
      );
  }

  /** Latest exchange rate base → quote (or the inverse of quote → base). */
  async rate(base: string, quote: string): Promise<Fraction | undefined> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: {
        validFrom: { lte: new Date() },
        OR: [
          { baseCurrencyCode: base, quoteCurrencyCode: quote },
          { baseCurrencyCode: quote, quoteCurrencyCode: base },
        ],
      },
      orderBy: { validFrom: 'desc' },
      take: 1,
    });
    const r = rows[0];
    if (!r) return undefined;
    const value = decimal(r.rate.toFixed(8));
    return r.baseCurrencyCode === base ? value : Fraction.of(1).div(value);
  }
}
