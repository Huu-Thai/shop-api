import { BadRequestException, Injectable } from '@nestjs/common';
import { CsvWriter, fileDate, parseCsv } from '../../common/csv/csv.js';
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
import { InventoryService } from './inventory.service.js';

const PAGE = 500;
const CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const COUNT = /^\d{1,10}$/;

async function sourceParam(
  prisma: PrismaService,
  p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  params.only(p, ['source']);
  const source = params.string(p, 'source', { max: 64, pattern: CODE });
  if (
    source &&
    !(await prisma.inventorySource.count({ where: { code: source } }))
  )
    throw new BadRequestException(`Unknown inventory source ${source}`);
  return source ? { source } : {};
}

/** `export.stock`: stock per source and SKU (quantity, reserved, safety stock, salable). */
@JobHandler()
@Injectable()
export class ExportStockJob implements JobRunner {
  readonly info = {
    type: 'export.stock',
    title: 'Export stock',
    description:
      'Stock per source and SKU: quantity, reserved, safety_stock and salable. Optional parameter source (a code).',
    permission: 'inventory:read',
    exampleParams: { source: 'main' },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsQuery,
  ) {}

  validate(p: Record<string, unknown>) {
    return sourceParam(this.prisma, p);
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const code = ctx.params.source as string | undefined;
    const where = code ? { source: { code } } : {};
    const csv = new CsvWriter([
      'source',
      'sku',
      'quantity',
      'reserved',
      'safety_stock',
      'salable',
    ]);
    const total = await this.prisma.inventory.count({ where });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.inventory.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          variantId: true,
          quantity: true,
          reserved: true,
          safetyStock: true,
          source: { select: { code: true } },
        },
      });
      if (!rows.length) break;
      const skus = await this.products.skusByVariantId(
        rows.map((r) => r.variantId),
      );
      csv.add(
        rows.map((r) => [
          r.source.code,
          skus.get(r.variantId) ?? '',
          r.quantity,
          r.reserved,
          r.safetyStock,
          Math.max(0, r.quantity - r.reserved - r.safetyStock),
        ]),
      );
      cursor = rows[rows.length - 1].id;
      await ctx.progress(csv.rows, total);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return {
      stats: { rows: csv.rows },
      output: {
        name: `stock${code ? `-${code}` : ''}-${fileDate()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}

/**
 * `import.stock`: sets counted quantities (and safety stock) per source and SKU through
 * InventoryService, which writes the ledger and never goes below what is reserved. Unchanged rows
 * are skipped, so importing the same file twice changes nothing.
 */
@JobHandler()
@Injectable()
export class ImportStockJob implements JobRunner {
  readonly info = {
    type: 'import.stock',
    title: 'Import stock',
    description:
      'CSV with sku, quantity and optional source (or the source parameter) and safety_stock. Sets the counted quantity (a CORRECTION movement in the ledger).',
    permission: 'inventory:write',
    input: 'csv' as const,
    exampleParams: { source: 'main' },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly products: ProductsQuery,
  ) {}

  validate(p: Record<string, unknown>) {
    return sourceParam(this.prisma, p);
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const principal = principalOf(ctx, this.info.permission);
    const { rows } = parseCsv(await ctx.input(), {
      required: ['sku', 'quantity'],
      allowed: [
        'source',
        'sku',
        'quantity',
        'safety_stock',
        'reserved',
        'salable',
      ],
    });
    const fallback = ctx.params.source as string | undefined;
    const sources = new Map(
      (
        await this.prisma.inventorySource.findMany({
          select: { id: true, code: true },
        })
      ).map((s) => [s.code, s.id]),
    );
    const stats = { rows: rows.length, updated: 0, unchanged: 0, failed: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += PAGE) {
      const chunk = rows.slice(i, i + PAGE);
      const variants = await this.products.variantIdsBySku(
        chunk.map((r) => r.values.sku).filter(Boolean),
      );
      const current = new Map(
        (
          await this.prisma.inventory.findMany({
            where: { variantId: { in: [...variants.values()] } },
            select: {
              sourceId: true,
              variantId: true,
              quantity: true,
              safetyStock: true,
            },
          })
        ).map((r) => [`${r.sourceId}/${r.variantId}`, r]),
      );
      for (const r of chunk) {
        const v = r.values;
        const fail = (m: string) => {
          stats.failed++;
          ctx.rowError(r.row, m);
        };
        const code = v.source || fallback;
        const sourceId = code ? sources.get(code) : undefined;
        if (!code) {
          fail('source is empty and no source parameter was given');
          continue;
        }
        if (!sourceId) {
          fail(`Unknown inventory source ${code}`);
          continue;
        }
        const variantId = variants.get(v.sku);
        if (!variantId) {
          fail(`Unknown SKU ${v.sku || '(empty)'}`);
          continue;
        }
        if (!COUNT.test(v.quantity)) {
          fail('quantity must be a whole number ≥ 0');
          continue;
        }
        if (v.safety_stock && !COUNT.test(v.safety_stock)) {
          fail('safety_stock must be a whole number ≥ 0');
          continue;
        }
        const key = `${sourceId}/${variantId}`;
        if (seen.has(key)) {
          fail(`${v.sku} appears twice for ${code}`);
          continue;
        }
        seen.add(key);
        const quantity = Number(v.quantity);
        const safetyStock = v.safety_stock ? Number(v.safety_stock) : undefined;
        const now = current.get(key);
        if (
          now &&
          now.quantity === quantity &&
          (safetyStock === undefined || now.safetyStock === safetyStock)
        ) {
          stats.unchanged++;
          continue;
        }
        try {
          await this.inventory.adjust(
            {
              sourceId,
              sku: v.sku,
              quantity,
              ...(safetyStock !== undefined ? { safetyStock } : {}),
              reason: 'CORRECTION',
              note: `Import ${ctx.executionId}`,
            },
            principal,
          );
          stats.updated++;
        } catch (e) {
          fail(errorText(e));
        }
      }
      await ctx.progress(Math.min(i + PAGE, rows.length), rows.length);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return { stats };
  }
}
