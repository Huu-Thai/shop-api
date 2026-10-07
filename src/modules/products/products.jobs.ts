import { Injectable } from '@nestjs/common';
import {
  CsvWriter,
  fileDate,
  parseCsv,
  type CsvRow,
} from '../../common/csv/csv.js';
import { validateDto } from '../../common/dto/validate-dto.js';
import { errorText } from '../../common/utils/error-text.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AttributesQuery } from '../catalog/attributes.query.js';
import {
  JobCanceledError,
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
  principalOf,
} from '../jobs/job-handler.js';
import { StoresQuery } from '../stores/stores.query.js';
import { CreateProductDto, UpdateProductDto } from './dto/product-input.dto.js';
import { ProductsService } from './products.service.js';

const PAGE = 500;
const TEXT_FIELDS = {
  name: 'name',
  short_description: 'shortDescription',
  description: 'description',
  meta_title: 'metaTitle',
  meta_description: 'metaDescription',
} as const;
type TextColumn = keyof typeof TEXT_FIELDS;
const LOCALIZED =
  /^(name|short_description|description|meta_title|meta_description)\[([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\]$/;
const STATUSES = ['ENABLED', 'DISABLED'];
const VISIBILITIES = ['CATALOG_SEARCH', 'CATALOG', 'SEARCH', 'NOT_VISIBLE'];
/** Types a CSV row can create; the others need options or variants (admin API). */
const CREATABLE = ['SIMPLE', 'VIRTUAL'];

const splitList = (v: string) =>
  v
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** `export.products`: one row per product, localized texts per locale column. */
@JobHandler()
@Injectable()
export class ExportProductsJob implements JobRunner {
  readonly info = {
    type: 'export.products',
    title: 'Export products',
    description:
      'Products (not variants) with type, status, visibility, attribute set, weight, websites and their texts per locale; the file can be edited and imported back.',
    permission: 'catalog:read',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly attributes: AttributesQuery,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, []);
    return {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const snap = await this.stores.snapshot(true);
    const locales = [...snap.locales.keys()].sort();
    const websiteCode = new Map(
      [...snap.byId.values()].map((s) => [s.websiteId, s.websiteCode]),
    );
    const sets = await this.attributes.setCodes();
    const csv = new CsvWriter([
      'sku',
      'type',
      'status',
      'visibility',
      'attribute_set',
      'weight_grams',
      'websites',
      ...locales.flatMap((l) =>
        (Object.keys(TEXT_FIELDS) as TextColumn[]).map((c) => `${c}[${l}]`),
      ),
    ]);
    const total = await this.prisma.product.count({
      where: { deletedAt: null },
    });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.product.findMany({
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          sku: true,
          type: true,
          status: true,
          visibility: true,
          attributeSetId: true,
          weightGrams: true,
          websites: { select: { websiteId: true } },
          translations: {
            select: {
              localeCode: true,
              name: true,
              shortDescription: true,
              description: true,
              metaTitle: true,
              metaDescription: true,
            },
          },
        },
      });
      if (!rows.length) break;
      csv.add(
        rows.map((p) => {
          const t = new Map(p.translations.map((x) => [x.localeCode, x]));
          return [
            p.sku,
            p.type,
            p.status,
            p.visibility,
            sets.get(p.attributeSetId) ?? '',
            p.weightGrams ?? '',
            p.websites
              .map((w) => websiteCode.get(w.websiteId))
              .filter(Boolean)
              .sort()
              .join('|'),
            ...locales.flatMap((l) =>
              Object.values(TEXT_FIELDS).map((f) => t.get(l)?.[f] ?? ''),
            ),
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
        name: `products-${fileDate()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}

/**
 * `import.products`: updates products by SKU (empty cells leave a field as it is) and creates simple
 * or virtual products for unknown SKUs. Every row goes through ProductsService, so it is validated,
 * audited and re-indexed exactly like an admin edit.
 */
@JobHandler()
@Injectable()
export class ImportProductsJob implements JobRunner {
  readonly info = {
    type: 'import.products',
    title: 'Import products',
    description:
      'CSV with `sku` and any of type, status, visibility, attribute_set, weight_grams, websites (codes separated by |) and name[locale], short_description[locale], description[locale], meta_title[locale], meta_description[locale]. Known SKUs are updated (empty cells are left unchanged); unknown SKUs create simple or virtual products.',
    permission: 'catalog:write',
    input: 'csv' as const,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly attributes: AttributesQuery,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, []);
    return {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const principal = principalOf(ctx, this.info.permission);
    const { rows } = parseCsv(await ctx.input(), {
      required: ['sku'],
      allowed: [
        'sku',
        'type',
        'status',
        'visibility',
        'attribute_set',
        'weight_grams',
        'websites',
        LOCALIZED,
      ],
    });
    const snap = await this.stores.snapshot(true);
    const websiteIds = new Map(
      [...snap.byId.values()].map((s) => [s.websiteCode, s.websiteId]),
    );
    const setIds = new Map(
      [...(await this.attributes.setCodes())].map(([id, code]) => [code, id]),
    );
    const stats = { rows: rows.length, created: 0, updated: 0, failed: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += PAGE) {
      const chunk = rows.slice(i, i + PAGE);
      const skus = chunk.map((r) => r.values.sku).filter(Boolean);
      const existing = new Map(
        (
          await this.prisma.product.findMany({
            where: { sku: { in: skus }, deletedAt: null },
            select: {
              id: true,
              sku: true,
              translations: { select: { localeCode: true, name: true } },
            },
          })
        ).map((p) => [p.sku, p]),
      );
      const variantSkus = new Set(
        (
          await this.prisma.productVariant.findMany({
            where: { sku: { in: skus.filter((s) => !existing.has(s)) } },
            select: { sku: true },
          })
        ).map((v) => v.sku),
      );
      for (const r of chunk) {
        const fail = (message: string) => {
          stats.failed++;
          ctx.rowError(r.row, message);
        };
        const sku = r.values.sku;
        if (!sku) {
          fail('sku is empty');
          continue;
        }
        if (seen.has(sku)) {
          fail(`${sku} appears more than once in the file`);
          continue;
        }
        seen.add(sku);
        if (variantSkus.has(sku)) {
          fail(`${sku} is a variant; import its product's SKU`);
          continue;
        }
        try {
          const current = existing.get(sku);
          const input = this.rowInput(r, websiteIds, setIds, current);
          if (current) {
            const { dto, errors } = await validateDto(
              UpdateProductDto,
              input.update,
            );
            if (errors.length) throw new Error(errors.join('; '));
            await this.products.update(current.id, dto, principal);
            stats.updated++;
          } else {
            const { dto, errors } = await validateDto(
              CreateProductDto,
              input.create,
            );
            if (errors.length) throw new Error(errors.join('; '));
            await this.products.create(dto, principal);
            stats.created++;
          }
        } catch (e) {
          fail(errorText(e));
        }
      }
      await ctx.progress(Math.min(i + PAGE, rows.length), rows.length);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return { stats };
  }

  /** The row as an update (only the filled cells) and as a creation. */
  private rowInput(
    r: CsvRow,
    websiteIds: Map<string, string>,
    setIds: Map<string, string>,
    current?: { translations: { localeCode: string; name: string }[] },
  ) {
    const v = r.values;
    const update: Record<string, unknown> = {};
    const status = v.status?.toUpperCase();
    if (status) {
      if (!STATUSES.includes(status))
        throw new Error(`status must be ${STATUSES.join(' or ')}`);
      update.status = status;
    }
    const visibility = v.visibility?.toUpperCase();
    if (visibility) {
      if (!VISIBILITIES.includes(visibility))
        throw new Error(`visibility must be one of ${VISIBILITIES.join(', ')}`);
      update.visibility = visibility;
    }
    if (v.weight_grams) {
      if (!/^\d{1,9}$/.test(v.weight_grams))
        throw new Error('weight_grams must be a whole number');
      update.weightGrams = Number(v.weight_grams);
    }
    if (v.websites) {
      const codes = splitList(v.websites);
      const unknown = codes.filter((c) => !websiteIds.has(c));
      if (unknown.length)
        throw new Error(`Unknown website(s): ${unknown.join(', ')}`);
      update.websiteIds = codes.map((c) => websiteIds.get(c)!);
    }
    const texts = new Map<string, Record<string, string>>();
    for (const [col, value] of Object.entries(v)) {
      const m = LOCALIZED.exec(col);
      if (!m || !value) continue;
      const t = texts.get(m[2]) ?? {};
      t[TEXT_FIELDS[m[1] as TextColumn]] = value;
      texts.set(m[2], t);
    }
    const translations = [...texts].map(([localeCode, t]) => {
      const name =
        t.name ??
        current?.translations.find((x) => x.localeCode === localeCode)?.name;
      if (!name) throw new Error(`name[${localeCode}] is required`);
      return { localeCode, ...t, name };
    });
    if (translations.length) update.translations = translations;

    if (v.attribute_set) {
      const id = setIds.get(v.attribute_set);
      if (!id) throw new Error(`Unknown attribute set ${v.attribute_set}`);
      update.attributeSetId = id;
    }
    // The type of an existing product never changes (the column is informative there).
    const create: Record<string, unknown> = { ...update, sku: v.sku };
    if (!current) {
      const type = (v.type || 'SIMPLE').toUpperCase();
      if (!CREATABLE.includes(type))
        throw new Error(
          `New ${type} products can't be created from CSV (simple or virtual only); create it in the admin, then import its texts`,
        );
      if (!translations.length)
        throw new Error('A new product needs at least one name[locale]');
      create.type = type;
    }
    return { update, create };
  }
}
