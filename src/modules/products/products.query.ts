import { Injectable } from '@nestjs/common';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import {
  type BundleInputType,
  Prisma,
  type ProductStatus,
  type ProductType,
  type ProductVisibility,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { StoreContext } from '../stores/context/store-context.js';

type Json = Record<string, unknown>;
export const LISTED: readonly ProductVisibility[] = [
  'CATALOG',
  'CATALOG_SEARCH',
];

export interface ListingQuery {
  categoryIds: string[];
  /** attribute code → accepted option codes (OR within an attribute, AND across attributes). */
  filters: Record<string, string[]>;
  sort: 'position' | 'name' | 'newest';
  page: number;
  limit: number;
}

export interface ProductSummaryRow {
  id: string;
  sku: string;
  type: ProductType;
  name: string;
  slug: string;
  shortDescription: string | null;
}

/** Everything the storefront product page needs from the products module (unresolved labels/URLs). */
export interface ProductViewRow extends ProductSummaryRow {
  /** Effective visibility in the store (override first). */
  visibility: ProductVisibility;
  createdAt: Date;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  localeCode: string;
  attributeSetId: string;
  /** Global values merged with the store override, plus the chosen translation's localizable values. */
  attributes: Json;
  typeOptions: Json;
  weightGrams: number | null;
  configurableAttributeIds: string[];
  variants: {
    id: string;
    sku: string;
    optionValues: Record<string, string>;
    isDefault: boolean;
    weightGrams: number | null;
  }[];
  bundleOptions: {
    code: string;
    inputType: BundleInputType;
    isRequired: boolean;
    title: string;
    selections: {
      variantId: string;
      productId: string;
      sku: string;
      qty: number;
      canChangeQty: boolean;
      isDefault: boolean;
    }[];
  }[];
  categoryIds: string[];
  relations: { related: string[]; upsell: string[]; crossSell: string[] };
}

const VISIBLE_IN = {
  RELATED: 'related',
  UPSELL: 'upsell',
  CROSSSELL: 'crossSell',
} as const;

/** Effective status/visibility in a store: override first, then the product's own. */
export function effective(
  p: { status: ProductStatus; visibility: ProductVisibility },
  o?: {
    status: ProductStatus | null;
    visibility: ProductVisibility | null;
  } | null,
): { status: ProductStatus; visibility: ProductVisibility } {
  return {
    status: o?.status ?? p.status,
    visibility: o?.visibility ?? p.visibility,
  };
}

export interface SellableUnits {
  type: ProductType;
  /** Enabled variants of the product itself (the default one for single-variant types). */
  variantIds: string[];
  /** BUNDLE: price type and options with their selections (enabled variants of other products). */
  bundle?: {
    priceType: 'DYNAMIC' | 'FIXED';
    options: {
      isRequired: boolean;
      selections: { variantId: string; productId: string; qty: number }[];
    }[];
  };
}

export interface CartLineFacts {
  variantId: string;
  sku: string;
  enabled: boolean;
  optionValues: Record<string, string>;
  productId: string;
  productSku: string;
  type: ProductType;
  taxClassId: string | null;
  categoryIds: string[];
  bundleOptions: {
    code: string;
    inputType: string;
    isRequired: boolean;
    selections: {
      variantId: string;
      sku: string;
      enabled: boolean;
      qty: number;
      canChangeQty: boolean;
      isDefault: boolean;
    }[];
  }[];
}

/** Read-only product access for other modules (storefront read models, URL rewrites). */
@Injectable()
export class ProductsQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** What URL rewrites need: slugs per locale and the websites selling the product. */
  async urlData(productId: string) {
    return this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        deletedAt: true,
        websites: { select: { websiteId: true } },
        translations: { select: { localeCode: true, slug: true } },
      },
    });
  }

  /** variant id → its product's tax class (null = standard) and product type. */
  async variantTaxInfo(
    variantIds: readonly string[],
  ): Promise<
    Map<
      string,
      { taxClassId: string | null; productId: string; type: ProductType }
    >
  > {
    if (!variantIds.length) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...variantIds] } },
      select: {
        id: true,
        productId: true,
        product: { select: { taxClassId: true, type: true } },
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          taxClassId: r.product.taxClassId,
          productId: r.productId,
          type: r.product.type,
        },
      ]),
    );
  }

  /** What a product card needs to price and stock-check each product. */
  async sellableUnits(
    productIds: readonly string[],
  ): Promise<Map<string, SellableUnits>> {
    if (!productIds.length) return new Map();
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...productIds] } },
      select: {
        id: true,
        type: true,
        typeOptions: true,
        variants: { where: { status: 'ENABLED' }, select: { id: true } },
        bundleOptions: {
          select: {
            isRequired: true,
            selections: {
              where: { variant: { status: 'ENABLED' } },
              select: {
                variantId: true,
                qty: true,
                variant: { select: { productId: true } },
              },
            },
          },
        },
      },
    });
    return new Map(
      rows.map((p) => [
        p.id,
        {
          type: p.type,
          variantIds: p.variants.map((v) => v.id),
          ...(p.type === 'BUNDLE'
            ? {
                bundle: {
                  priceType:
                    (p.typeOptions as { priceType?: 'DYNAMIC' | 'FIXED' })
                      .priceType ?? 'DYNAMIC',
                  options: p.bundleOptions.map((o) => ({
                    isRequired: o.isRequired,
                    selections: o.selections.map((sel) => ({
                      variantId: sel.variantId,
                      productId: sel.variant.productId,
                      qty: sel.qty,
                    })),
                  })),
                },
              }
            : {}),
        },
      ]),
    );
  }

  async productIdsOfVariants(variantIds: readonly string[]): Promise<string[]> {
    if (!variantIds.length) return [];
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...variantIds] } },
      select: { productId: true },
      distinct: ['productId'],
    });
    return rows.map((r) => r.productId);
  }

  async productIdsInCategories(
    categoryIds: readonly string[],
  ): Promise<string[]> {
    if (!categoryIds.length) return [];
    const rows = await this.prisma.productCategory.findMany({
      where: { categoryId: { in: [...categoryIds] } },
      select: { productId: true },
      distinct: ['productId'],
    });
    return rows.map((r) => r.productId);
  }

  /** SKU → variant id (unknown SKUs are absent). */
  /** Variant id → SKU (exports name variants by SKU). */
  async skusByVariantId(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, sku: true },
    });
    return new Map(rows.map((r) => [r.id, r.sku]));
  }

  async variantIdsBySku(skus: readonly string[]): Promise<Map<string, string>> {
    if (!skus.length) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { sku: { in: [...skus] } },
      select: { id: true, sku: true },
    });
    return new Map(rows.map((r) => [r.sku, r.id]));
  }

  /**
   * What promotion rules match on, per SKU (variant or product SKU): the product, its variant and
   * its categories. Deleted products and unknown SKUs are absent.
   */
  async cartFacts(
    skus: readonly string[],
  ): Promise<
    Map<string, { productId: string; variantId: string; categoryIds: string[] }>
  > {
    if (!skus.length) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { sku: { in: [...skus] }, product: { deletedAt: null } },
      select: {
        id: true,
        sku: true,
        productId: true,
        product: { select: { categories: { select: { categoryId: true } } } },
      },
    });
    return new Map(
      rows.map((r) => [
        r.sku,
        {
          productId: r.productId,
          variantId: r.id,
          categoryIds: r.product.categories.map((c) => c.categoryId),
        },
      ]),
    );
  }

  /** What a cart needs per variant: identity, type, tax class, categories and bundle options. */
  async cartLines(
    variantIds: readonly string[],
  ): Promise<Map<string, CartLineFacts>> {
    if (!variantIds.length) return new Map();
    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: [...variantIds] }, product: { deletedAt: null } },
      select: {
        id: true,
        sku: true,
        status: true,
        optionValues: true,
        product: {
          select: {
            id: true,
            sku: true,
            type: true,
            taxClassId: true,
            categories: { select: { categoryId: true } },
            bundleOptions: {
              orderBy: { position: 'asc' },
              select: {
                code: true,
                inputType: true,
                isRequired: true,
                selections: {
                  orderBy: { position: 'asc' },
                  select: {
                    variantId: true,
                    qty: true,
                    canChangeQty: true,
                    isDefault: true,
                    variant: { select: { sku: true, status: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          variantId: r.id,
          sku: r.sku,
          enabled: r.status === 'ENABLED',
          optionValues: (r.optionValues ?? {}) as Record<string, string>,
          productId: r.product.id,
          productSku: r.product.sku,
          type: r.product.type,
          taxClassId: r.product.taxClassId,
          categoryIds: r.product.categories.map((c) => c.categoryId),
          bundleOptions: r.product.bundleOptions.map((o) => ({
            code: o.code,
            inputType: o.inputType,
            isRequired: o.isRequired,
            selections: o.selections.map((sel) => ({
              variantId: sel.variantId,
              sku: sel.variant.sku,
              enabled: sel.variant.status === 'ENABLED',
              qty: sel.qty,
              canChangeQty: sel.canChangeQty,
              isDefault: sel.isDefault,
            })),
          })),
        },
      ]),
    );
  }

  async variantIdsOfProduct(productId: string): Promise<string[]> {
    const rows = await this.prisma.productVariant.findMany({
      where: { productId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Product ids sold on a website (for a full URL rebuild). */
  async idsOnWebsite(websiteId: string): Promise<string[]> {
    const rows = await this.prisma.product.findMany({
      where: { deletedAt: null, websites: { some: { websiteId } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Category listing in one statement: website assignment, effective status/visibility with the
   * store override, attribute filters against product attributes (+ override patch) or enabled
   * variant options, and sorting by category position, localized name (ICU root collation, so
   * accented names like "Áo" sort with "A") or newest.
   */
  async listing(
    ctx: StoreContext,
    q: ListingQuery,
  ): Promise<{ ids: string[]; total: number }> {
    const filters = Object.entries(q.filters).map(([code, values]) => {
      const alternatives = values.map((v) => JSON.stringify({ [code]: v }));
      const multi = values.map((v) => JSON.stringify({ [code]: [v] }));
      return Prisma.sql`(
        (p.attributes || COALESCE(o.attributes, '{}'::jsonb)) @> ANY (${alternatives}::jsonb[])
        OR (p.attributes || COALESCE(o.attributes, '{}'::jsonb)) @> ANY (${multi}::jsonb[])
        OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.status = 'ENABLED'
                   AND v.option_values @> ANY (${alternatives}::jsonb[])))`;
    });
    const order =
      q.sort === 'name'
        ? Prisma.sql`sort_name ASC NULLS LAST, p.id`
        : q.sort === 'newest'
          ? Prisma.sql`p.created_at DESC, p.id`
          : Prisma.sql`sort_position ASC, p.created_at DESC, p.id`;
    const rows = await this.prisma.$queryRaw<{ id: string; total: bigint }[]>`
      SELECT p.id, count(*) OVER () AS total,
             (SELECT min(pc.position) FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY (${q.categoryIds}::uuid[])) AS sort_position,
             (SELECT t.name COLLATE "und-x-icu" FROM product_translations t WHERE t.product_id = p.id AND t.locale_code = ANY (${ctx.localeChain})
               ORDER BY array_position(${ctx.localeChain}::varchar[], t.locale_code) LIMIT 1) AS sort_name
        FROM products p
        LEFT JOIN product_store_overrides o ON o.product_id = p.id AND o.store_id = ${ctx.storeId}::uuid
       WHERE p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM product_websites w WHERE w.product_id = p.id AND w.website_id = ${ctx.websiteId}::uuid)
         AND EXISTS (SELECT 1 FROM product_categories c WHERE c.product_id = p.id AND c.category_id = ANY (${q.categoryIds}::uuid[]))
         AND COALESCE(o.status, p.status) = 'ENABLED'
         AND COALESCE(o.visibility, p.visibility) IN ('CATALOG', 'CATALOG_SEARCH')
         ${filters.length ? Prisma.sql`AND ${Prisma.join(filters, ' AND ')}` : Prisma.empty}
       ORDER BY ${order}
       LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;
    return { ids: rows.map((r) => r.id), total: Number(rows[0]?.total ?? 0) };
  }

  /** Ids of products visible to this store (website, enabled, not hidden), preserving order. */
  async visibleIds(
    ctx: StoreContext,
    ids: readonly string[],
    listedOnly = false,
  ): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.product.findMany({
      where: {
        id: { in: [...ids] },
        deletedAt: null,
        websites: { some: { websiteId: ctx.websiteId } },
      },
      select: {
        id: true,
        status: true,
        visibility: true,
        storeOverrides: {
          where: { storeId: ctx.storeId },
          select: { status: true, visibility: true },
        },
      },
    });
    const ok = new Set(
      rows
        .filter((r) => {
          const e = effective(r, r.storeOverrides[0]);
          return (
            e.status === 'ENABLED' &&
            (listedOnly
              ? LISTED.includes(e.visibility)
              : e.visibility !== 'NOT_VISIBLE')
          );
        })
        .map((r) => r.id),
    );
    return ids.filter((id) => ok.has(id));
  }

  /** Localized summaries for cards and lists, in the order of `ids` (unknown ids dropped). */
  async summaries(
    ctx: StoreContext,
    ids: readonly string[],
  ): Promise<ProductSummaryRow[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        sku: true,
        type: true,
        translations: {
          where: { localeCode: { in: ctx.localeChain } },
          select: {
            localeCode: true,
            name: true,
            slug: true,
            shortDescription: true,
          },
        },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      const t = r && pickTranslation(r.translations, ctx.localeChain);
      return r && t
        ? [
            {
              id: r.id,
              sku: r.sku,
              type: r.type,
              name: t.name,
              slug: t.slug,
              shortDescription: t.shortDescription,
            },
          ]
        : [];
    });
  }

  /** Which of `ids` are existing (not deleted) products. */
  async existing(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Product id for a slug in the request's locale chain. */
  async idBySlug(ctx: StoreContext, slug: string): Promise<string | undefined> {
    const rows = await this.prisma.productTranslation.findMany({
      where: { slug, localeCode: { in: ctx.localeChain } },
      select: { productId: true, localeCode: true },
    });
    return pickTranslation(rows, ctx.localeChain)?.productId;
  }

  /** The storefront view of one product, or undefined when this store can't show it. */
  async view(
    ctx: StoreContext,
    id: string,
  ): Promise<ProductViewRow | undefined> {
    const [visible] = await this.visibleIds(ctx, [id]);
    if (!visible) return undefined;
    const p = await this.prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        type: true,
        attributeSetId: true,
        status: true,
        visibility: true,
        createdAt: true,
        attributes: true,
        typeOptions: true,
        weightGrams: true,
        translations: { where: { localeCode: { in: ctx.localeChain } } },
        storeOverrides: {
          where: { storeId: ctx.storeId },
          select: { attributes: true, status: true, visibility: true },
        },
        configurableAttributes: {
          select: { attributeId: true },
          orderBy: { position: 'asc' },
        },
        variants: {
          where: { status: 'ENABLED' },
          select: {
            id: true,
            sku: true,
            optionValues: true,
            isDefault: true,
            weightGrams: true,
          },
          orderBy: [{ position: 'asc' }, { sku: 'asc' }],
        },
        bundleOptions: {
          orderBy: { position: 'asc' },
          select: {
            code: true,
            inputType: true,
            isRequired: true,
            translations: {
              where: { localeCode: { in: ctx.localeChain } },
              select: { localeCode: true, title: true },
            },
            selections: {
              orderBy: { position: 'asc' },
              select: {
                variantId: true,
                qty: true,
                canChangeQty: true,
                isDefault: true,
                variant: {
                  select: { sku: true, status: true, productId: true },
                },
              },
            },
          },
        },
        categories: {
          select: { categoryId: true },
          orderBy: { position: 'asc' },
        },
        relations: {
          select: { relatedProductId: true, type: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    const t = p && pickTranslation(p.translations, ctx.localeChain);
    if (!p || !t) return undefined;

    // Bundle selections only offer variants this store can sell.
    const childIds = [
      ...new Set(
        p.bundleOptions.flatMap((o) =>
          o.selections.map((s) => s.variant.productId),
        ),
      ),
    ];
    const sellable = new Set(await this.visibleIds(ctx, childIds));
    const relations: ProductViewRow['relations'] = {
      related: [],
      upsell: [],
      crossSell: [],
    };
    for (const r of p.relations)
      relations[VISIBLE_IN[r.type]].push(r.relatedProductId);
    const relatedVisible = new Set(
      await this.visibleIds(
        ctx,
        p.relations.map((r) => r.relatedProductId),
        true,
      ),
    );
    for (const k of Object.keys(relations) as (keyof typeof relations)[])
      relations[k] = relations[k].filter((i) => relatedVisible.has(i));

    return {
      id: p.id,
      sku: p.sku,
      type: p.type,
      name: t.name,
      slug: t.slug,
      shortDescription: t.shortDescription,
      description: t.description,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      localeCode: t.localeCode,
      visibility: effective(p, p.storeOverrides[0]).visibility,
      createdAt: p.createdAt,
      attributeSetId: p.attributeSetId,
      attributes: {
        ...(p.attributes as Json),
        ...(p.storeOverrides[0]?.attributes as Json | undefined),
        ...(t.attributes as Json),
      },
      typeOptions: p.typeOptions as Json,
      weightGrams: p.weightGrams,
      configurableAttributeIds: p.configurableAttributes.map(
        (c) => c.attributeId,
      ),
      variants: p.variants.map((v) => ({
        ...v,
        optionValues: v.optionValues as Record<string, string>,
      })),
      bundleOptions: p.bundleOptions
        .map((o) => ({
          code: o.code,
          inputType: o.inputType,
          isRequired: o.isRequired,
          title:
            pickTranslation(o.translations, ctx.localeChain)?.title ?? o.code,
          selections: o.selections
            .filter(
              (s) =>
                s.variant.status === 'ENABLED' &&
                sellable.has(s.variant.productId),
            )
            .map((s) => ({
              variantId: s.variantId,
              productId: s.variant.productId,
              sku: s.variant.sku,
              qty: s.qty,
              canChangeQty: s.canChangeQty,
              isDefault: s.isDefault,
            })),
        }))
        .filter((o) => o.selections.length),
      categoryIds: p.categories.map((c) => c.categoryId),
      relations,
    };
  }
}
