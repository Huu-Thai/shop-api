import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { CustomersQuery } from '../customers/customers.query.js';
import { GUEST_GROUP } from '../customers/customers.events.js';
import { ProductsQuery } from '../products/products.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import {
  DEFAULT_CUSTOMER_TAX_CLASS,
  DEFAULT_PRODUCT_TAX_CLASS,
  TaxQuery,
} from '../tax/tax.query.js';
import { calculateTax } from '../tax/tax-engine.js';
import type {
  PricePreviewDto,
  PricePreviewQueryDto,
} from './dto/pricing.dto.js';
import { type ComputedTier, PriceComputation } from './price-computation.js';
import type { BookScope, EntryInput } from './price-resolver.js';
import { tierFor } from './price-resolver.js';
import { PRICE_INDEX_EVENTS } from './pricing.events.js';

const BATCH = 200;

/**
 * Builds `price_index` (PLAN.md §9): for each variant × store × customer group × store currency,
 * the tier list from the matching price books with net and gross for the store's country.
 * Storefront reads never resolve price books themselves.
 */
@Injectable()
export class PriceIndexer {
  private readonly logger = new Logger(PriceIndexer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly stores: StoresQuery,
    private readonly customers: CustomersQuery,
    private readonly products: ProductsQuery,
    private readonly tax: TaxQuery,
  ) {}

  private async computation(at: Date) {
    const [tax, books] = await Promise.all([
      this.tax.definitions(true),
      this.prisma.priceBook.findMany(),
    ]);
    const classId = (id: string | null, fallback: string) =>
      id ?? tax.classIds.get(fallback)!;
    return {
      comp: new PriceComputation(tax, books as BookScope[], at),
      classId,
    };
  }

  /** Rebuilds the given variants, or every priced/indexed variant. Returns rows written. */
  async rebuild(
    variantIds?: readonly string[],
  ): Promise<{ variants: number; rows: number }> {
    const at = new Date();
    const ids = variantIds?.length
      ? [...new Set(variantIds)]
      : await this.allVariantIds();
    const [{ comp, classId }, snap, groups] = await Promise.all([
      this.computation(at),
      this.stores.snapshot(true),
      this.customers.groups(),
    ]);
    const stores = [...snap.byId.values()];
    let rows = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const [entries, info] = await Promise.all([
        this.prisma.priceBookEntry.findMany({
          where: { variantId: { in: batch } },
          select: {
            variantId: true,
            priceBookId: true,
            minQty: true,
            amount: true,
            compareAtAmount: true,
          },
        }),
        this.products.variantTaxInfo(batch),
      ]);
      const data: Prisma.PriceIndexCreateManyInput[] = [];
      for (const variantId of batch) {
        const v = info.get(variantId);
        const own = entries.filter((e) => e.variantId === variantId);
        if (!v || !own.length) continue;
        const productTaxClassId = classId(
          v.taxClassId,
          DEFAULT_PRODUCT_TAX_CLASS,
        );
        for (const store of stores)
          for (const group of groups) {
            const setting = {
              destination: { countryCode: store.countryCode },
              productTaxClassId,
              customerTaxClassId: classId(
                group.taxClassId,
                DEFAULT_CUSTOMER_TAX_CLASS,
              ),
            };
            const taxRate = comp.taxRate(setting);
            for (const currencyCode of store.currencyCodes)
              for (const t of comp.tiers(
                {
                  storeId: store.id,
                  websiteId: store.websiteId,
                  customerGroupId: group.id,
                  currencyCode,
                },
                own,
                setting,
              ))
                data.push({
                  variantId,
                  storeId: store.id,
                  customerGroupId: group.id,
                  currencyCode,
                  minQty: t.minQty,
                  netAmount: t.net,
                  grossAmount: t.gross,
                  compareAtNet: t.compareAtNet,
                  compareAtGross: t.compareAtGross,
                  taxRate,
                  priceBookId: t.book.id,
                  indexedAt: at,
                });
          }
      }
      await this.bus.write({
        before: new BeforeWriteEvent(
          PRICE_INDEX_EVENTS.BEFORE_REBUILD,
          'rebuild',
          null,
          SYSTEM_ACTOR,
          { variants: batch.length },
        ),
        work: async (tx, after) => {
          await tx.priceIndex.deleteMany({
            where: { variantId: { in: batch } },
          });
          if (data.length) await tx.priceIndex.createMany({ data });
          after.add(
            new ProjectionEvent(PRICE_INDEX_EVENTS.REBUILT, {
              variantIds: batch,
              rows: data.length,
            }),
          );
        },
        timeoutMs: 120_000,
      });
      rows += data.length;
    }
    this.logger.log(`Price index: ${ids.length} variant(s), ${rows} row(s)`);
    return { variants: ids.length, rows };
  }

  private async allVariantIds(): Promise<string[]> {
    const [priced, indexed] = await Promise.all([
      this.prisma.priceBookEntry.findMany({
        distinct: ['variantId'],
        select: { variantId: true },
      }),
      this.prisma.priceIndex.findMany({
        distinct: ['variantId'],
        select: { variantId: true },
      }),
    ]);
    return [...new Set([...priced, ...indexed].map((r) => r.variantId))];
  }

  /** Variants priced by books whose validity window opened or closed in (since, until]. */
  async variantsWithBoundaries(since: Date, until: Date): Promise<string[]> {
    const rows = await this.prisma.priceBookEntry.findMany({
      where: {
        priceBook: {
          OR: [
            { validFrom: { gt: since, lte: until } },
            { validTo: { gt: since, lte: until } },
          ],
        },
      },
      distinct: ['variantId'],
      select: { variantId: true },
    });
    return rows.map((r) => r.variantId);
  }

  /** Live resolution of one variant (admin debugging; does not read the index). */
  async preview(q: PricePreviewQueryDto): Promise<PricePreviewDto> {
    const at = q.at ? new Date(q.at) : new Date();
    const store = await this.stores.store(q.storeId, true);
    if (!store) throw new NotFoundException(`Store ${q.storeId} not found`);
    const group = await this.customers.groupByCode(
      q.customerGroup ?? GUEST_GROUP,
    );
    const [{ comp, classId }, info, entries, tax] = await Promise.all([
      this.computation(at),
      this.products.variantTaxInfo([q.variantId]),
      this.prisma.priceBookEntry.findMany({
        where: { variantId: q.variantId },
      }) as Promise<(EntryInput & { variantId: string })[]>,
      this.tax.definitions(true),
    ]);
    const v = info.get(q.variantId);
    if (!v) throw new NotFoundException(`Variant ${q.variantId} not found`);
    const setting = {
      destination: { countryCode: store.countryCode },
      productTaxClassId: classId(v.taxClassId, DEFAULT_PRODUCT_TAX_CLASS),
      customerTaxClassId: classId(group.taxClassId, DEFAULT_CUSTOMER_TAX_CLASS),
    };
    const ctx = {
      storeId: store.id,
      websiteId: store.websiteId,
      customerGroupId: group.id,
      currencyCode: q.currency ?? store.defaultCurrencyCode,
    };
    const tiers = comp.tiers(ctx, entries, setting);
    const qty = q.qty ?? 1;
    const applied = tierFor(tiers, qty);
    // The line as checkout would compute it: unit price × qty, taxed in the book's mode.
    const line = applied
      ? calculateTax(
          {
            lines: [
              {
                key: 'line',
                amount:
                  (applied.book.includesTax ? applied.gross : applied.net) *
                  BigInt(qty),
                productTaxClassId: setting.productTaxClassId,
              },
            ],
            destination: setting.destination,
            customerTaxClassId: setting.customerTaxClassId,
            pricesIncludeTax: applied.book.includesTax,
            date: at,
          },
          tax.zones,
          tax.rates,
        ).totals
      : { net: 0n, tax: 0n, gross: 0n };
    const dto = (t: ComputedTier) => ({
      minQty: t.minQty,
      net: Number(t.net),
      gross: Number(t.gross),
      priceBook: t.book.code,
    });
    return {
      books: comp.ranked(ctx).map((b) => b.code),
      tiers: tiers.map(dto),
      applied: applied ? dto(applied) : null,
      qty,
      lineNet: Number(line.net),
      lineTax: Number(line.tax),
      lineGross: Number(line.gross),
      taxRate: comp.taxRate(setting),
      currency: ctx.currencyCode,
    };
  }
}
