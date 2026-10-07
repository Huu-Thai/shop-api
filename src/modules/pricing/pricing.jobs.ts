import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CsvWriter,
  decimalToMinor,
  fileDate,
  minorToDecimal,
  parseCsv,
} from '../../common/csv/csv.js';
import { errorText } from '../../common/utils/error-text.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  JobCanceledError,
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
  principalOf,
} from '../jobs/job-handler.js';
import { ProductsQuery } from '../products/products.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import type { PriceEntryInputDto } from './dto/pricing.dto.js';
import { PriceBooksService } from './price-books.service.js';
import { PriceIndexListener } from './price-index.listener.js';

/** `prices.reindex`: a full price index rebuild (the worker coalesces concurrent requests). */
@JobHandler()
@Injectable()
export class PricesReindexJob implements JobRunner {
  readonly info = {
    type: 'prices.reindex',
    title: 'Rebuild the price index',
    description:
      'Recomputes every effective price (books, tiers, tax, exchange rates) for every store, group and currency.',
    permission: 'pricing:write',
  };

  constructor(private readonly index: PriceIndexListener) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, []);
    return {};
  }

  async run(): Promise<JobOutcome> {
    await this.index.rebuild();
    return { stats: { queued: 1 } };
  }
}

const PAGE = 500;
const CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** `export.prices`: price book entries (all books, or one), amounts as decimals. */
@JobHandler()
@Injectable()
export class ExportPricesJob implements JobRunner {
  readonly info = {
    type: 'export.prices',
    title: 'Export prices',
    description:
      'Price book entries: price_book, currency, sku, min_qty, price and compare_at_price (decimals). Optional parameter priceBook (a code).',
    permission: 'pricing:read',
    exampleParams: { priceBook: 'us-retail' },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsQuery,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['priceBook']);
    const priceBook = params.string(p, 'priceBook', { max: 64, pattern: CODE });
    if (
      priceBook &&
      !(await this.prisma.priceBook.count({ where: { code: priceBook } }))
    )
      throw new BadRequestException(`Unknown price book ${priceBook}`);
    return priceBook ? { priceBook } : {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const code = ctx.params.priceBook as string | undefined;
    const where = code ? { priceBook: { code } } : {};
    const { currencies } = await this.stores.snapshot(true);
    const csv = new CsvWriter([
      'price_book',
      'currency',
      'sku',
      'min_qty',
      'price',
      'compare_at_price',
    ]);
    const total = await this.prisma.priceBookEntry.count({ where });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.priceBookEntry.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          variantId: true,
          minQty: true,
          amount: true,
          compareAtAmount: true,
          priceBook: { select: { code: true, currencyCode: true } },
        },
      });
      if (!rows.length) break;
      const skus = await this.products.skusByVariantId(
        rows.map((r) => r.variantId),
      );
      csv.add(
        rows.map((r) => {
          const minor =
            currencies.get(r.priceBook.currencyCode)?.minorUnits ?? 2;
          return [
            r.priceBook.code,
            r.priceBook.currencyCode,
            skus.get(r.variantId) ?? '',
            r.minQty,
            minorToDecimal(r.amount, minor),
            r.compareAtAmount == null
              ? ''
              : minorToDecimal(r.compareAtAmount, minor),
          ];
        }),
      );
      cursor = rows[rows.length - 1].id;
      await ctx.progress(csv.rows, total);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return {
      stats: { rows: csv.rows },
      output: {
        name: `prices${code ? `-${code}` : ''}-${fileDate()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}

/**
 * `import.prices`: upserts entries by (price book, SKU, min_qty) through PriceBooksService (the
 * price index follows through its events). Rows with problems are reported, the others applied.
 */
@JobHandler()
@Injectable()
export class ImportPricesJob implements JobRunner {
  readonly info = {
    type: 'import.prices',
    title: 'Import prices',
    description:
      'CSV with sku, price and optional price_book (or the priceBook parameter), min_qty (default 1) and compare_at_price. Prices are decimals in the book currency; currency, if present, must match the book.',
    permission: 'pricing:write',
    input: 'csv' as const,
    exampleParams: { priceBook: 'us-retail' },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly books: PriceBooksService,
    private readonly products: ProductsQuery,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['priceBook']);
    const priceBook = params.string(p, 'priceBook', { max: 64, pattern: CODE });
    if (
      priceBook &&
      !(await this.prisma.priceBook.count({ where: { code: priceBook } }))
    )
      throw new BadRequestException(`Unknown price book ${priceBook}`);
    return priceBook ? { priceBook } : {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const principal = principalOf(ctx, this.info.permission);
    const { rows } = parseCsv(await ctx.input(), {
      required: ['sku', 'price'],
      allowed: [
        'price_book',
        'currency',
        'sku',
        'min_qty',
        'price',
        'compare_at_price',
      ],
    });
    const fallbackBook = ctx.params.priceBook as string | undefined;
    const books = new Map(
      (
        await this.prisma.priceBook.findMany({
          select: { id: true, code: true, currencyCode: true },
        })
      ).map((b) => [b.code, b]),
    );
    const { currencies } = await this.stores.snapshot(true);
    const stats = { rows: rows.length, upserted: 0, failed: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += PAGE) {
      const chunk = rows.slice(i, i + PAGE);
      const known = await this.products.variantIdsBySku(
        chunk.map((r) => r.values.sku).filter(Boolean),
      );
      const byBook = new Map<
        string,
        { row: number; entry: PriceEntryInputDto }[]
      >();
      for (const r of chunk) {
        const v = r.values;
        const fail = (m: string) => {
          stats.failed++;
          ctx.rowError(r.row, m);
        };
        const code = v.price_book || fallbackBook;
        const book = code ? books.get(code) : undefined;
        if (!code) {
          fail('price_book is empty and no priceBook parameter was given');
          continue;
        }
        if (!book) {
          fail(`Unknown price book ${code}`);
          continue;
        }
        if (v.currency && v.currency.toUpperCase() !== book.currencyCode) {
          fail(`${code} is priced in ${book.currencyCode}, not ${v.currency}`);
          continue;
        }
        if (!known.has(v.sku)) {
          fail(`Unknown SKU ${v.sku || '(empty)'}`);
          continue;
        }
        const minQty = v.min_qty ? Number(v.min_qty) : 1;
        if (!Number.isInteger(minQty) || minQty < 1 || minQty > 1_000_000) {
          fail('min_qty must be a whole number from 1');
          continue;
        }
        const minor = currencies.get(book.currencyCode)?.minorUnits ?? 2;
        const amount = decimalToMinor(v.price, minor);
        if (amount === null) {
          fail(
            `price must be a non-negative amount with at most ${minor} decimals`,
          );
          continue;
        }
        const compare = v.compare_at_price
          ? decimalToMinor(v.compare_at_price, minor)
          : undefined;
        if (compare === null) {
          fail('compare_at_price is not a valid amount');
          continue;
        }
        if (compare !== undefined && compare <= amount) {
          fail('compare_at_price must be higher than price');
          continue;
        }
        const key = `${book.id}/${v.sku}/${minQty}`;
        if (seen.has(key)) {
          fail(`${v.sku} (min_qty ${minQty}) appears twice for ${code}`);
          continue;
        }
        seen.add(key);
        const list = byBook.get(book.id) ?? [];
        list.push({
          row: r.row,
          entry: {
            sku: v.sku,
            minQty,
            amount: Number(amount),
            ...(compare !== undefined
              ? { compareAtAmount: Number(compare) }
              : {}),
          },
        });
        byBook.set(book.id, list);
      }
      for (const [bookId, list] of byBook)
        try {
          const r = await this.books.setEntries(
            bookId,
            { entries: list.map((l) => l.entry) },
            principal,
          );
          stats.upserted += r.upserted;
        } catch (e) {
          for (const l of list) {
            stats.failed++;
            ctx.rowError(l.row, errorText(e));
          }
        }
      await ctx.progress(Math.min(i + PAGE, rows.length), rows.length);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return { stats };
  }
}
