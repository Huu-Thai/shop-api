import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ImageRole } from '../../database/generated/prisma/client.js';
import type { AttributeDef } from '../catalog/attribute-values.js';
import {
  AttributesQuery,
  type LocalizedAttribute,
} from '../catalog/attributes.query.js';
import {
  breadcrumbs,
  CategoriesQuery,
  type VisibleCategory,
  visibleSubtree,
} from '../catalog/categories.query.js';
import { buildTree } from '../catalog/category-tree.js';
import { type ImageView, MediaQuery } from '../media/media.query.js';
import type {
  BundleTypeOptions,
  GiftCardTypeOptions,
} from '../products/product-types.js';
import {
  ProductsQuery,
  type ProductViewRow,
} from '../products/products.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { StorefrontResponseCache } from '../stores/context/storefront-response-cache.js';
import { UrlRewritesQuery } from '../url-rewrites/url-rewrites.query.js';
import { InventoryQuery } from '../inventory/inventory.query.js';
import { CmsQuery } from '../cms/cms.query.js';
import { type PriceView, PricingQuery } from '../pricing/pricing.query.js';
import type { SellableUnits } from '../products/products.query.js';
import {
  bundleFromPrice,
  bundleInStock,
  lowest,
  stockOf,
} from './price-composition.js';
import type {
  CategoryProductsQueryDto,
  StorefrontAttributeValueDto,
  StorefrontCategoryDto,
  StorefrontCategoryNodeDto,
  StorefrontImageDto,
  StorefrontProductCardDto,
  StorefrontProductDto,
  StorefrontProductListDto,
  StorefrontUrlResolutionDto,
} from './dto/storefront.dto.js';

const image = (i: ImageView): StorefrontImageDto => ({
  url: i.url,
  width: i.width,
  height: i.height,
  alt: i.alt,
  role: i.role,
  renditions: i.renditions,
});
const CARD_ROLES: ImageRole[] = ['SMALL', 'BASE'];
export const cardImage = (images: ImageView[] = []) => {
  const pick =
    CARD_ROLES.map((r) => images.find((i) => i.role === r)).find(Boolean) ??
    images[0];
  return pick ? image(pick) : null;
};

/** Display text of an attribute value (option labels for selects). */
export function valueLabel(attr: LocalizedAttribute, value: unknown): string {
  const label = (code: unknown) =>
    attr.options.get(String(code))?.label ?? String(code);
  if (attr.def.type === 'SELECT') return label(value);
  if (attr.def.type === 'MULTISELECT')
    return (value as unknown[]).map(label).join(', ');
  if (attr.def.type === 'BOOLEAN') return value ? 'Yes' : 'No';
  return String(value);
}

/** Parses `color:red,blue` filters into `{ color: ['red', 'blue'] }` (merging repeats). */
export function parseFilters(
  raw: readonly string[] = [],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of raw) {
    const [code, values] = f.split(':');
    out[code] = [...new Set([...(out[code] ?? []), ...values.split(',')])];
  }
  return out;
}

/** Every variant whose price or stock a product's offer needs (its own and its bundle's). */
export const unitVariants = (u: SellableUnits): string[] => [
  ...u.variantIds,
  ...(u.bundle?.options.flatMap((o) => o.selections.map((s) => s.variantId)) ??
    []),
];

/** A card's catalog part (cached; prices and stock are added per request). */
interface CardBase {
  row: Awaited<ReturnType<ProductsQuery['summaries']>>[number];
  urlPath: string | null;
  image: StorefrontImageDto | null;
  units: SellableUnits | null;
  /** Bundle children that are sold in this store. */
  sellableChildren: string[];
}

type PageVariant = Omit<
  StorefrontProductDto['variants'][number],
  'price' | 'stock'
>;
type PageSelection = Omit<
  NonNullable<
    StorefrontProductDto['bundle']
  >['options'][number]['selections'][number],
  'price' | 'inStock'
>;

/** A product page's catalog part (cached; prices and stock are added per request). */
interface ProductBase {
  units: SellableUnits;
  relatedIds: string[];
  upsellIds: string[];
  crossSellIds: string[];
  page: Omit<
    StorefrontProductDto,
    | 'variants'
    | 'bundle'
    | 'price'
    | 'inStock'
    | 'related'
    | 'upsell'
    | 'crossSell'
  > & {
    variants: PageVariant[];
    bundle:
      | (Omit<NonNullable<StorefrontProductDto['bundle']>, 'options'> & {
          options: (Omit<
            NonNullable<StorefrontProductDto['bundle']>['options'][number],
            'selections'
          > & { selections: PageSelection[] })[];
        })
      | null;
  };
}

/** Page-shaped storefront read models (PLAN.md §7.1), composed from the modules' *Query services. */
@Injectable()
export class StorefrontCatalogService {
  constructor(
    private readonly categories: CategoriesQuery,
    private readonly products: ProductsQuery,
    private readonly attributes: AttributesQuery,
    private readonly media: MediaQuery,
    private readonly urls: UrlRewritesQuery,
    private readonly pricing: PricingQuery,
    private readonly inventory: InventoryQuery,
    private readonly cms: CmsQuery,
    private readonly cache: StorefrontResponseCache,
  ) {}

  /** Prices, stock and a formatter for a set of variants in one round. */
  private async commerce(ctx: StoreContext, variantIds: readonly string[]) {
    const ids = [...new Set(variantIds)];
    const [prices, stock, format] = await Promise.all([
      this.pricing.prices(ctx, ids),
      this.inventory.salable(ctx.websiteId, ids),
      this.pricing.formatter(ctx),
    ]);
    return {
      price: (id: string) => prices.get(id),
      stock: (id: string) => stockOf(stock.get(id)),
      format,
    };
  }

  private async categoryDtos(
    ctx: StoreContext,
    cats: VisibleCategory[],
  ): Promise<StorefrontCategoryDto[]> {
    const ids = cats.map((c) => c.id);
    const [paths, images] = await Promise.all([
      this.urls.canonicalPaths(ctx, 'CATEGORY', ids),
      this.media.imagesFor('CATEGORY', ids, ctx.localeChain),
    ]);
    return cats.map((c) => ({
      ...c,
      urlPath: paths.get(c.id) ?? null,
      image: cardImage(images.get(c.id)),
    }));
  }

  async categoryTree(ctx: StoreContext): Promise<StorefrontCategoryNodeDto[]> {
    const visible = await this.categories.visible(
      ctx.websiteId,
      ctx.localeChain,
    );
    return buildTree(
      await this.categoryDtos(ctx, [...visible.values()]),
    ) as StorefrontCategoryNodeDto[];
  }

  async category(
    ctx: StoreContext,
    id: string,
  ): Promise<StorefrontCategoryDto> {
    const c = (
      await this.categories.visible(ctx.websiteId, ctx.localeChain)
    ).get(id);
    if (!c) throw new NotFoundException(`Category ${id} not found`);
    return (await this.categoryDtos(ctx, [c]))[0];
  }

  async categoryProducts(
    ctx: StoreContext,
    id: string,
    q: CategoryProductsQueryDto,
  ): Promise<StorefrontProductListDto> {
    const visible = await this.categories.visible(
      ctx.websiteId,
      ctx.localeChain,
    );
    if (!visible.has(id))
      throw new NotFoundException(`Category ${id} not found`);
    const filters = parseFilters(q.filter);
    const defs = await this.attributes.byCodes(Object.keys(filters));
    const bad = Object.keys(filters).filter((c) => !defs.get(c)?.isFilterable);
    if (bad.length)
      throw new BadRequestException(`Not filterable: ${bad.join(', ')}`);
    const { ids, total } = await this.products.listing(ctx, {
      categoryIds: q.includeSubcategories ? visibleSubtree(visible, id) : [id],
      filters,
      sort: q.sort,
      page: q.page,
      limit: q.limit,
    });
    return {
      data: await this.cards(ctx, ids),
      total,
      page: q.page,
      limit: q.limit,
    };
  }

  /** Read-model cache key: these parts depend on the store, locale and currency. */
  private key(ctx: StoreContext, kind: string, id: string): string {
    return `${kind}:${ctx.storeCode}:${ctx.localeCode}:${ctx.currencyCode}:${id}`;
  }

  /**
   * Product cards: the catalog part (name, URL, image, sellable units) comes from the cache, prices
   * and stock are worked out now. Unknown or hidden products are left out.
   */
  async cards(
    ctx: StoreContext,
    ids: readonly string[],
  ): Promise<StorefrontProductCardDto[]> {
    if (!ids.length) return [];
    const keys = ids.map((id) => this.key(ctx, 'card', id));
    const { values, version } = await this.cache.getModels<CardBase | null>(
      keys,
    );
    const missing = ids.filter((_, i) => values[i] === undefined);
    const loaded = missing.length
      ? await this.cardBases(ctx, missing)
      : new Map<string, CardBase>();
    if (missing.length)
      void this.cache.setModels(
        missing.map((id) => ({
          key: this.key(ctx, 'card', id),
          value: loaded.get(id) ?? null,
        })),
        version,
      );
    const bases = ids
      .map((id, i) => values[i] ?? loaded.get(id) ?? null)
      .filter((b): b is CardBase => !!b);
    const c = await this.commerce(
      ctx,
      bases.flatMap((b) => (b.units ? unitVariants(b.units) : [])),
    );
    return bases.map((b) => {
      const { price, inStock } = b.units
        ? this.offer(b.units, c, new Set(b.sellableChildren))
        : { price: undefined, inStock: false };
      return {
        ...b.row,
        urlPath: b.urlPath,
        image: b.image,
        price: price ?? null,
        inStock,
      };
    });
  }

  /** The cacheable part of cards (no prices or stock). */
  private async cardBases(
    ctx: StoreContext,
    ids: readonly string[],
  ): Promise<Map<string, CardBase>> {
    const rows = await this.products.summaries(ctx, ids);
    const visibleIds = rows.map((r) => r.id);
    const units = await this.products.sellableUnits(visibleIds);
    const childProducts = [...units.values()].flatMap(
      (u) =>
        u.bundle?.options.flatMap((o) =>
          o.selections.map((s) => s.productId),
        ) ?? [],
    );
    const [sellable, paths, images] = await Promise.all([
      this.products.visibleIds(ctx, [...new Set(childProducts)]),
      this.urls.canonicalPaths(ctx, 'PRODUCT', visibleIds),
      this.media.imagesFor('PRODUCT', visibleIds, ctx.localeChain),
    ]);
    const sellableChildren = new Set(sellable);
    return new Map(
      rows.map((r) => {
        const u = units.get(r.id) ?? null;
        return [
          r.id,
          {
            row: r,
            urlPath: paths.get(r.id) ?? null,
            image: cardImage(images.get(r.id)),
            units: u,
            sellableChildren: (
              u?.bundle?.options.flatMap((o) =>
                o.selections.map((s) => s.productId),
              ) ?? []
            ).filter((id) => sellableChildren.has(id)),
          },
        ];
      }),
    );
  }

  /** "From" price and availability of a product (shared by cards and the product page). */
  private offer(
    u: SellableUnits,
    c: Awaited<ReturnType<StorefrontCatalogService['commerce']>>,
    sellableChildren?: ReadonlySet<string>,
  ): { price: PriceView | undefined; inStock: boolean } {
    if (u.type === 'GIFT_CARD') return { price: undefined, inStock: true };
    if (u.bundle) {
      const required = u.bundle.options
        .filter((o) => o.isRequired)
        .map((o) =>
          o.selections
            .filter(
              (s) => !sellableChildren || sellableChildren.has(s.productId),
            )
            .map((s) => ({
              price: c.price(s.variantId),
              qty: s.qty,
              inStock: c.stock(s.variantId).inStock,
            })),
        );
      const inStock = bundleInStock(required);
      const price =
        u.bundle.priceType === 'FIXED'
          ? c.price(u.variantIds[0])
          : bundleFromPrice(required, c.format);
      return { price, inStock };
    }
    const available = u.variantIds.filter((v) => c.stock(v).inStock);
    return {
      price: lowest((available.length ? available : u.variantIds).map(c.price)),
      inStock: available.length > 0,
    };
  }

  async productBySlug(
    ctx: StoreContext,
    slug: string,
  ): Promise<StorefrontProductDto> {
    const key = this.key(ctx, 'slug', slug);
    const { values, version } = await this.cache.getModels<string>([key]);
    let id = values[0];
    if (!id) {
      id = (await this.products.idBySlug(ctx, slug)) ?? undefined;
      if (!id) throw new NotFoundException(`Product "${slug}" not found`);
      void this.cache.setModels([{ key, value: id }], version);
    }
    return this.product(ctx, id);
  }

  /**
   * The product page: its catalog part (texts, attributes, media, variants, bundle options,
   * breadcrumbs) is cached until the catalog changes; prices and stock are worked out now.
   */
  async product(ctx: StoreContext, id: string): Promise<StorefrontProductDto> {
    const key = this.key(ctx, 'product', id);
    const { values, version } = await this.cache.getModels<ProductBase>([key]);
    let base = values[0];
    if (!base) {
      base = await this.productBase(ctx, id);
      void this.cache.setModels([{ key, value: base }], version);
    }
    const [c, related, upsell, crossSell] = await Promise.all([
      this.commerce(ctx, unitVariants(base.units)),
      this.cards(ctx, base.relatedIds),
      this.cards(ctx, base.upsellIds),
      this.cards(ctx, base.crossSellIds),
    ]);
    const offer = this.offer(base.units, c);
    const { page } = base;
    return {
      ...page,
      variants: page.variants.map((v) => ({
        ...v,
        price: c.price(v.id) ?? null,
        stock: c.stock(v.id),
      })),
      bundle: page.bundle
        ? {
            ...page.bundle,
            options: page.bundle.options.map((o) => ({
              ...o,
              selections: o.selections.map((s) => ({
                ...s,
                price: c.price(s.variantId) ?? null,
                inStock: c.stock(s.variantId).inStock,
              })),
            })),
          }
        : null,
      price: offer.price ?? null,
      inStock: offer.inStock,
      related,
      upsell,
      crossSell,
    };
  }

  /** The cacheable part of the product page (no prices or stock). */
  private async productBase(
    ctx: StoreContext,
    id: string,
  ): Promise<ProductBase> {
    const p = await this.products.view(ctx, id);
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    const axes = (await this.attributes.byIds(
      p.configurableAttributeIds,
    )) as Map<string, AttributeDef>;
    const axisCodes = p.configurableAttributeIds.map((a) => axes.get(a)!.code);
    const setDefs =
      (await this.attributes.setDefinitions(p.attributeSetId)) ??
      new Map<string, AttributeDef>();
    const shown = Object.keys(p.attributes).filter(
      (c) => setDefs.get(c)?.isVisible && !axisCodes.includes(c),
    );
    const [labels, images, variantImages, paths, visible] = await Promise.all([
      this.attributes.localized([...shown, ...axisCodes], ctx.localeChain),
      this.media.imagesFor('PRODUCT', [p.id], ctx.localeChain),
      this.media.imagesFor(
        'VARIANT',
        p.variants.map((v) => v.id),
        ctx.localeChain,
      ),
      this.urls.canonicalPaths(ctx, 'PRODUCT', [p.id]),
      this.categories.visible(ctx.websiteId, ctx.localeChain),
    ]);
    const crumbCategory = p.categoryIds.find((c) => visible.has(c));
    const crumbs = crumbCategory ? breadcrumbs(visible, crumbCategory) : [];
    const [crumbPaths, children] = await Promise.all([
      this.urls.canonicalPaths(
        ctx,
        'CATEGORY',
        crumbs.map((c) => c.id),
      ),
      this.products.summaries(
        ctx,
        p.bundleOptions.flatMap((o) => o.selections.map((s) => s.productId)),
      ),
    ]);
    const childNames = new Map(children.map((s) => [s.id, s.name]));
    const units: SellableUnits = {
      type: p.type,
      variantIds: p.variants.map((v) => v.id),
      ...(p.type === 'BUNDLE'
        ? {
            bundle: {
              priceType:
                (p.typeOptions as unknown as BundleTypeOptions).priceType ??
                'DYNAMIC',
              options: p.bundleOptions.map((o) => ({
                isRequired: o.isRequired,
                selections: o.selections,
              })),
            },
          }
        : {}),
    };
    return {
      units,
      relatedIds: p.relations.related,
      upsellIds: p.relations.upsell,
      crossSellIds: p.relations.crossSell,
      page: {
        id: p.id,
        sku: p.sku,
        type: p.type,
        name: p.name,
        slug: p.slug,
        urlPath: paths.get(p.id) ?? null,
        locale: p.localeCode,
        shortDescription: p.shortDescription,
        description: p.description,
        metaTitle: p.metaTitle,
        metaDescription: p.metaDescription,
        weightGrams: p.weightGrams,
        attributes: this.attributeValues(p, shown, labels),
        images: (images.get(p.id) ?? []).map(image),
        breadcrumbs: crumbs.map((c) => ({
          id: c.id,
          name: c.name,
          urlPath: crumbPaths.get(c.id) ?? null,
        })),
        configurableOptions: axisCodes.map((code) => {
          const attr = labels.get(code)!;
          const used = new Set(p.variants.map((v) => v.optionValues[code]));
          return {
            code,
            label: attr.label,
            values: [...attr.options.entries()]
              .filter(([c]) => used.has(c))
              .sort(([, a], [, b]) => a.position - b.position)
              .map(([c, o]) => ({ code: c, label: o.label, swatch: o.swatch })),
          };
        }),
        variants: p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          options: v.optionValues,
          images: (variantImages.get(v.id) ?? []).map(image),
        })),
        bundle:
          p.type === 'BUNDLE'
            ? {
                ...(p.typeOptions as unknown as BundleTypeOptions),
                options: p.bundleOptions.map((o) => ({
                  ...o,
                  selections: o.selections.map((s) => ({
                    ...s,
                    name: childNames.get(s.productId) ?? s.sku,
                  })),
                })),
              }
            : null,
        giftCard:
          p.type === 'GIFT_CARD'
            ? this.giftCard(
                ctx,
                p.typeOptions as unknown as GiftCardTypeOptions,
              )
            : null,
      },
    };
  }

  private attributeValues(
    p: ProductViewRow,
    codes: string[],
    labels: Map<string, LocalizedAttribute>,
  ): StorefrontAttributeValueDto[] {
    return codes
      .map((code) => ({ code, attr: labels.get(code) }))
      .filter((x): x is { code: string; attr: LocalizedAttribute } => !!x.attr)
      .sort(
        (a, b) =>
          a.attr.def.position - b.attr.def.position ||
          a.code.localeCompare(b.code),
      )
      .map(({ code, attr }) => ({
        code,
        label: attr.label,
        value: p.attributes[code],
        valueLabel: valueLabel(attr, p.attributes[code]),
      }));
  }

  /** Preset amounts in the request currency (Phase 2 adds conversion). */
  private giftCard(ctx: StoreContext, o: GiftCardTypeOptions) {
    return {
      cardType: o.cardType,
      amounts: o.amounts.filter((a) => a.currency === ctx.currencyCode),
      allowOpenAmount: o.allowOpenAmount,
      openAmountMin: o.openAmountMin ?? null,
      openAmountMax: o.openAmountMax ?? null,
      lifetimeDays: o.lifetimeDays ?? null,
    };
  }

  async resolve(
    ctx: StoreContext,
    path: string,
  ): Promise<StorefrontUrlResolutionDto> {
    const r = await this.urls.resolve(ctx, path);
    // CMS content keeps its URL while scheduled; it resolves only once it is visible.
    const cmsKind =
      r?.type === 'CMS_PAGE' ? 'page' : r?.type === 'CMS_POST' ? 'post' : null;
    const hidden =
      cmsKind &&
      !(await this.cms.visibleTitles(ctx, cmsKind, [r!.id!])).has(r!.id!);
    if (!r || hidden) throw new NotFoundException(`No page at ${path}`);
    return r;
  }
}
