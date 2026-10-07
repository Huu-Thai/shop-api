import { assertSkusFree } from './sku.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  assertUniqueLocales,
  resolveSlug,
} from '../../common/dto/translation.dto.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type {
  Prisma,
  ProductRelationType,
} from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import {
  type AttributeDef,
  mergeValues,
  validateAttributes,
} from '../catalog/attribute-values.js';
import { AttributesQuery } from '../catalog/attributes.query.js';
import { BundleOptionsWriter } from './bundle-options.writer.js';
import type {
  CreateProductDto,
  ProductCategoryInputDto,
  ProductTranslationInputDto,
  SetRelationsDto,
  StoreOverrideInputDto,
  UpdateProductDto,
} from './dto/product-input.dto.js';
import type {
  ListProductsQueryDto,
  ProductDto,
  ProductListItemDto,
  SearchVariantsQueryDto,
  StoreOverrideDto,
  VariantSearchItemDto,
} from './dto/product-view.dto.js';
import { PRODUCT_SELECT, toProductDto } from './product.select.js';
import {
  axisErrors,
  SINGLE_VARIANT_TYPES,
  validateTypeOptions,
  validateVariantOptions,
  weightErrors,
  BUNDLEABLE_TYPES,
} from './product-types.js';
import {
  PRODUCT_EVENTS,
  type ProductEventData,
  type ProductWriteInput,
} from './products.events.js';

type Json = Record<string, unknown>;
type TranslationRow = {
  localeCode: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  attributes: Json;
};

const fail = (errors: string[]) => {
  if (errors.length) throw new BadRequestException(errors);
};
const slugsOf = (rows: readonly { localeCode: string; slug: string }[]) =>
  rows.map(({ localeCode, slug }) => ({ localeCode, slug }));
const uniqueCategories = (cats: ProductCategoryInputDto[] = []) => {
  const ids = cats.map((c) => c.categoryId);
  if (new Set(ids).size !== ids.length)
    throw new BadRequestException('categories lists a category twice');
  return cats.map((c, i) => ({
    categoryId: c.categoryId,
    position: c.position ?? i,
  }));
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly attributes: AttributesQuery,
    private readonly bundles: BundleOptionsWriter,
  ) {}

  async list(q: ListProductsQueryDto): Promise<Paginated<ProductListItemDto>> {
    const where: Prisma.ProductWhereInput = {
      ...(q.includeDeleted ? {} : { deletedAt: null }),
      type: q.type,
      status: q.status,
      attributeSetId: q.attributeSetId,
      ...(q.ids ? { id: { in: q.ids } } : {}),
      ...(q.websiteId
        ? { websites: { some: { websiteId: q.websiteId } } }
        : {}),
      ...(q.categoryId
        ? { categories: { some: { categoryId: q.categoryId } } }
        : {}),
      ...(q.search
        ? {
            OR: [
              { sku: { contains: q.search, mode: 'insensitive' } },
              {
                translations: {
                  some: { name: { contains: q.search, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: {
          id: true,
          sku: true,
          type: true,
          status: true,
          visibility: true,
          updatedAt: true,
          deletedAt: true,
          translations: {
            select: { localeCode: true, name: true },
            orderBy: { localeCode: 'asc' },
          },
          _count: { select: { variants: true } },
        },
        orderBy: { [q.sort ?? 'updatedAt']: q.order },
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginated(
      rows.map(({ translations, _count, ...p }) => ({
        ...p,
        name:
          (
            translations.find((t) => t.localeCode === q.locale) ??
            translations[0]
          )?.name ?? null,
        variantCount: _count.variants,
      })),
      total,
      q,
    );
  }

  /** Variants by SKU or product (for price entries, bundles and other pickers). */
  async searchVariants(
    q: SearchVariantsQueryDto,
  ): Promise<VariantSearchItemDto[]> {
    const search = q.search?.trim();
    const rows = await this.prisma.productVariant.findMany({
      where: {
        product: {
          deletedAt: null,
          id: q.productId,
          ...(q.bundleable ? { type: { in: [...BUNDLEABLE_TYPES] } } : {}),
        },
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' } },
                { product: { sku: { contains: search, mode: 'insensitive' } } },
                {
                  product: {
                    translations: {
                      some: { name: { contains: search, mode: 'insensitive' } },
                    },
                  },
                },
              ],
            }
          : {}),
      },
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
            translations: {
              select: { localeCode: true, name: true },
              orderBy: { localeCode: 'asc' },
            },
          },
        },
      },
      orderBy: [{ sku: 'asc' }],
      take: q.limit ?? 20,
    });
    return rows.map((v) => ({
      id: v.id,
      sku: v.sku,
      status: v.status,
      optionValues: (v.optionValues ?? {}) as Record<string, string>,
      productId: v.product.id,
      productSku: v.product.sku,
      productType: v.product.type,
      productName:
        (
          v.product.translations.find((t) => t.localeCode === q.locale) ??
          v.product.translations[0]
        )?.name ?? null,
    }));
  }

  async get(id: string): Promise<ProductDto> {
    const p = await this.prisma.product.findUnique({
      where: { id },
      select: PRODUCT_SELECT,
    });
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    return toProductDto(p);
  }

  private async definitions(
    attributeSetId: string,
  ): Promise<Map<string, AttributeDef>> {
    const defs = await this.attributes.setDefinitions(attributeSetId);
    if (!defs)
      throw new BadRequestException(
        `Attribute set ${attributeSetId} does not exist`,
      );
    return defs;
  }

  private translationRow(
    t: ProductTranslationInputDto,
    defs: Map<string, AttributeDef>,
    existing: Json,
    errors: string[],
  ): TranslationRow {
    const where = `translations[${t.localeCode}]`;
    const { values, errors: e } = validateAttributes(
      defs,
      mergeValues(existing, t.attributes as Json | undefined),
      {
        localizable: true,
        requireAll: true,
        path: `${where}.`,
      },
    );
    errors.push(...e);
    return {
      localeCode: t.localeCode,
      name: t.name,
      slug: resolveSlug(t.name, t.slug, where),
      shortDescription: t.shortDescription ?? null,
      description: t.description ?? null,
      metaTitle: t.metaTitle ?? null,
      metaDescription: t.metaDescription ?? null,
      attributes: values,
    };
  }

  async create(dto: CreateProductDto, actor: Principal): Promise<ProductDto> {
    assertUniqueLocales(dto.translations);
    const errors: string[] = [];
    const attributeSetId = dto.attributeSetId ?? (await this.defaultSetId());
    const defs = await this.definitions(attributeSetId);
    const configurable = dto.type === 'CONFIGURABLE';

    const typeOptions = validateTypeOptions(dto.type, dto.typeOptions);
    errors.push(
      ...typeOptions.errors,
      ...weightErrors(dto.type, typeOptions.value, dto.weightGrams),
    );
    if (
      !configurable &&
      (dto.configurableAttributes?.length || dto.variants?.length)
    )
      errors.push(
        'Only CONFIGURABLE products have configurableAttributes and variants',
      );
    if (dto.type !== 'BUNDLE' && dto.bundleOptions?.length)
      errors.push('Only BUNDLE products have bundleOptions');

    const axisCodes = configurable ? (dto.configurableAttributes ?? []) : [];
    if (configurable) errors.push(...axisErrors(axisCodes, defs));
    const axes = axisCodes
      .map((c) => defs.get(c))
      .filter((d): d is AttributeDef => !!d);
    const global = validateAttributes(defs, (dto.attributes as Json) ?? {}, {
      localizable: false,
      requireAll: true,
      exclude: new Set(axisCodes),
    });
    errors.push(...global.errors);
    const translations = dto.translations.map((t) =>
      this.translationRow(t, defs, {}, errors),
    );

    const variants = (dto.variants ?? []).map((v, i) => {
      const r = validateVariantOptions(
        axes,
        v.options,
        `variants[${i}].options`,
      );
      errors.push(...r.errors);
      return {
        sku: v.sku,
        optionValues: r.values,
        optionSignature: r.signature,
        status: v.status ?? 'ENABLED',
        weightGrams: v.weightGrams ?? null,
        position: v.position ?? i,
      };
    });
    const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
    for (const s of dup(variants.map((v) => v.optionSignature).filter(Boolean)))
      errors.push(`Two variants have the same options (${s})`);
    for (const s of dup(variants.map((v) => v.sku)))
      errors.push(`Variant SKU ${s} is used twice`);
    fail(errors);
    const categories = uniqueCategories(dto.categories);

    const product = await this.bus.write({
      before: new BeforeWriteEvent<ProductWriteInput>(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        {
          sku: dto.sku,
          taxClassId: dto.taxClassId,
          slugs: slugsOf(translations),
        },
      ),
      work: async (tx, after) => {
        await assertSkusFree(tx, [dto.sku, ...variants.map((v) => v.sku)]);
        const axisIds = axisCodes.map((c) => defs.get(c)!.id);
        const p = await tx.product.create({
          data: {
            sku: dto.sku,
            type: dto.type,
            status: dto.status ?? 'ENABLED',
            visibility: dto.visibility ?? 'CATALOG_SEARCH',
            attributeSetId,
            attributes: global.values as Prisma.InputJsonObject,
            typeOptions: typeOptions.value as Prisma.InputJsonObject,
            weightGrams: dto.weightGrams ?? null,
            taxClassId: dto.taxClassId ?? null,
            translations: {
              create: translations.map((t) => ({
                ...t,
                attributes: t.attributes as Prisma.InputJsonObject,
              })),
            },
            websites: {
              create: [...new Set(dto.websiteIds ?? [])].map((websiteId) => ({
                websiteId,
              })),
            },
            categories: { create: categories },
            configurableAttributes: {
              create: axisIds.map((attributeId, position) => ({
                attributeId,
                position,
              })),
            },
            variants: {
              create: SINGLE_VARIANT_TYPES.has(dto.type)
                ? [
                    {
                      sku: dto.sku,
                      isDefault: true,
                      weightGrams: dto.weightGrams ?? null,
                    },
                  ]
                : variants.map((v) => ({ ...v, optionValues: v.optionValues })),
            },
          },
          select: { id: true },
        });
        if (dto.bundleOptions?.length)
          await this.bundles.replace(tx, p.id, dto.bundleOptions);
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.CREATED,
            actorOf(actor),
            'product',
            p.id,
            { sku: dto.sku, type: dto.type, variants: variants.length || 1 },
            { productId: p.id, urlsChanged: true },
          ),
        );
        return p;
      },
    });
    return this.get(product.id);
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    actor: Principal,
  ): Promise<ProductDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    const current = await this.prisma.product.findUnique({
      where: { id },
      select: PRODUCT_SELECT,
    });
    if (!current) throw new NotFoundException(`Product ${id} not found`);
    if (current.deletedAt)
      throw new ConflictException('The product is deleted; restore it first');
    const before = toProductDto(current);
    const errors: string[] = [];
    const attributeSetId = dto.attributeSetId ?? before.attributeSetId;
    const defs = await this.definitions(attributeSetId);
    const axisCodes = before.configurableAttributes;
    for (const c of axisCodes)
      if (!defs.has(c))
        errors.push(
          `The attribute set must contain the configurable attribute ${c}`,
        );

    const global = validateAttributes(
      defs,
      mergeValues(before.attributes, dto.attributes as Json | undefined),
      {
        localizable: false,
        requireAll: true,
        exclude: new Set(axisCodes),
      },
    );
    errors.push(...global.errors);
    const typeOptions = dto.typeOptions
      ? validateTypeOptions(before.type, dto.typeOptions)
      : { value: before.typeOptions, errors: [] };
    errors.push(...typeOptions.errors);
    const weightGrams =
      dto.weightGrams === undefined ? before.weightGrams : dto.weightGrams;
    errors.push(...weightErrors(before.type, typeOptions.value, weightGrams));
    const translations = (dto.translations ?? []).map((t) =>
      this.translationRow(
        t,
        defs,
        before.translations.find((x) => x.localeCode === t.localeCode)
          ?.attributes ?? {},
        errors,
      ),
    );
    // A changed attribute set re-validates the translations that are not being rewritten.
    if (dto.attributeSetId && dto.attributeSetId !== before.attributeSetId)
      for (const t of before.translations)
        if (
          !translations.some((x) => x.localeCode === t.localeCode) &&
          !dto.removeLocales?.includes(t.localeCode)
        )
          errors.push(
            ...validateAttributes(defs, t.attributes, {
              localizable: true,
              requireAll: true,
              path: `translations[${t.localeCode}].`,
            }).errors,
          );
    fail(errors);
    const categories = dto.categories
      ? uniqueCategories(dto.categories)
      : undefined;

    await this.bus.write({
      before: new BeforeWriteEvent<ProductWriteInput>(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        {
          sku: dto.sku,
          taxClassId: dto.taxClassId,
          slugs: slugsOf(translations),
        },
      ),
      work: async (tx, after) => {
        if (dto.sku && dto.sku !== before.sku)
          await assertSkusFree(tx, [dto.sku], id);
        for (const t of translations) {
          const data = {
            ...t,
            attributes: t.attributes as Prisma.InputJsonObject,
          };
          await tx.productTranslation.upsert({
            where: {
              productId_localeCode: { productId: id, localeCode: t.localeCode },
            },
            create: { productId: id, ...data },
            update: data,
          });
        }
        if (dto.removeLocales?.length)
          await tx.productTranslation.deleteMany({
            where: { productId: id, localeCode: { in: dto.removeLocales } },
          });
        if (!(await tx.productTranslation.count({ where: { productId: id } })))
          throw new BadRequestException(
            'A product needs at least one translation',
          );
        await tx.product.update({
          where: { id },
          data: {
            sku: dto.sku,
            status: dto.status,
            visibility: dto.visibility,
            attributeSetId,
            attributes: global.values as Prisma.InputJsonObject,
            typeOptions: typeOptions.value as Prisma.InputJsonObject,
            weightGrams,
            taxClassId: dto.taxClassId,
            ...(dto.websiteIds
              ? {
                  websites: {
                    deleteMany: {},
                    create: [...new Set(dto.websiteIds)].map((websiteId) => ({
                      websiteId,
                    })),
                  },
                }
              : {}),
            ...(categories
              ? { categories: { deleteMany: {}, create: categories } }
              : {}),
          },
        });
        // The default variant mirrors the product's SKU and weight.
        if (SINGLE_VARIANT_TYPES.has(before.type))
          await tx.productVariant.updateMany({
            where: { productId: id, isDefault: true },
            data: { sku: dto.sku ?? before.sku, weightGrams },
          });
        const now = toProductDto(
          await tx.product.findUniqueOrThrow({
            where: { id },
            select: PRODUCT_SELECT,
          }),
        );
        const names = (p: ProductDto) =>
          p.translations.map(({ attributes: _a, ...t }) => t);
        const changes = diff(
          { ...before, translations: names(before) } as never,
          { ...now, translations: names(now) } as never,
          [
            'sku',
            'status',
            'visibility',
            'attributeSetId',
            'attributes',
            'typeOptions',
            'weightGrams',
            'taxClassId',
            'translations',
            'websiteIds',
            'categories',
          ],
        );
        if (Object.keys(changes).length) {
          const urls = (p: ProductDto) =>
            JSON.stringify([slugsOf(p.translations), p.websiteIds]);
          after.add(
            new EntityEvent<ProductEventData>(
              PRODUCT_EVENTS.UPDATED,
              actorOf(actor),
              'product',
              id,
              changes,
              {
                productId: id,
                urlsChanged: urls(before) !== urls(now),
                taxClassChanged: 'taxClassId' in changes,
              },
            ),
          );
        }
      },
    });
    return this.get(id);
  }

  /** Soft delete: the product leaves every storefront; SKU and slugs stay reserved until restored. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent<ProductWriteInput>(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        const p = await tx.product.findUnique({
          where: { id },
          select: { sku: true, deletedAt: true },
        });
        if (!p) throw new NotFoundException(`Product ${id} not found`);
        if (p.deletedAt) return;
        await tx.product.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.DELETED,
            actorOf(actor),
            'product',
            id,
            { sku: p.sku },
            { productId: id, urlsChanged: true },
          ),
        );
      },
    });
  }

  async restore(id: string, actor: Principal): Promise<ProductDto> {
    await this.bus.write({
      before: new BeforeWriteEvent<ProductWriteInput>(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'restore',
        id,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        const p = await tx.product.findUnique({
          where: { id },
          select: { sku: true, deletedAt: true },
        });
        if (!p) throw new NotFoundException(`Product ${id} not found`);
        if (!p.deletedAt) return;
        await tx.product.update({ where: { id }, data: { deletedAt: null } });
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.RESTORED,
            actorOf(actor),
            'product',
            id,
            { sku: p.sku },
            { productId: id, urlsChanged: true },
          ),
        );
      },
    });
    return this.get(id);
  }

  /** Sparse per-store differences; an override with nothing left is deleted. */
  async setStoreOverride(
    id: string,
    storeId: string,
    dto: StoreOverrideInputDto,
    actor: Principal,
  ): Promise<StoreOverrideDto | null> {
    const p = await this.prisma.product.findUnique({
      where: { id },
      select: {
        attributeSetId: true,
        configurableAttributes: {
          select: { attribute: { select: { code: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    const defs = await this.definitions(p.attributeSetId);
    const attrs = validateAttributes(defs, (dto.attributes as Json) ?? {}, {
      localizable: false,
      exclude: new Set(p.configurableAttributes.map((c) => c.attribute.code)),
      path: 'override.',
    });
    fail(attrs.errors);
    return this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'store-override',
        id,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        const existing = await tx.productStoreOverride.findUnique({
          where: { productId_storeId: { productId: id, storeId } },
        });
        const next = {
          status:
            dto.status === undefined ? (existing?.status ?? null) : dto.status,
          visibility:
            dto.visibility === undefined
              ? (existing?.visibility ?? null)
              : dto.visibility,
          attributes:
            dto.attributes === undefined
              ? ((existing?.attributes as Json) ?? {})
              : attrs.values,
        };
        const empty =
          !next.status &&
          !next.visibility &&
          !Object.keys(next.attributes).length;
        let result: StoreOverrideDto | null = null;
        if (empty)
          await tx.productStoreOverride.deleteMany({
            where: { productId: id, storeId },
          });
        else {
          const data = {
            ...next,
            attributes: next.attributes as Prisma.InputJsonObject,
          };
          await tx.productStoreOverride.upsert({
            where: { productId_storeId: { productId: id, storeId } },
            create: { productId: id, storeId, ...data },
            update: data,
          });
          result = { storeId, ...next };
        }
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.STORE_OVERRIDE_CHANGED,
            actorOf(actor),
            'product',
            id,
            { storeId, override: result },
            { productId: id, urlsChanged: false },
          ),
        );
        return result;
      },
    });
  }

  async setRelations(
    id: string,
    dto: SetRelationsDto,
    actor: Principal,
  ): Promise<ProductDto> {
    const lists: [ProductRelationType, string[]][] = [
      ['RELATED', dto.related ?? []],
      ['UPSELL', dto.upsell ?? []],
      ['CROSSSELL', dto.crossSell ?? []],
    ];
    const ids = [...new Set(lists.flatMap(([, l]) => l))];
    if (ids.includes(id))
      throw new BadRequestException('A product cannot be related to itself');
    for (const [type, l] of lists)
      if (new Set(l).size !== l.length)
        throw new BadRequestException(`${type} lists a product twice`);
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'relations',
        id,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        await assertProducts(tx, [id, ...ids]);
        await tx.productRelation.deleteMany({ where: { productId: id } });
        await tx.productRelation.createMany({
          data: lists.flatMap(([type, l]) =>
            l.map((relatedProductId, position) => ({
              productId: id,
              relatedProductId,
              type,
              position,
            })),
          ),
        });
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.RELATIONS_CHANGED,
            actorOf(actor),
            'product',
            id,
            { ...dto },
            { productId: id, urlsChanged: false },
          ),
        );
      },
    });
    return this.get(id);
  }

  private async defaultSetId(): Promise<string> {
    const s = await this.prisma.attributeSet.findUnique({
      where: { code: 'default' },
      select: { id: true },
    });
    if (!s)
      throw new BadRequestException(
        'attributeSetId is required (no "default" attribute set exists)',
      );
    return s.id;
  }
}

/** Every id is an existing, non-deleted product. */
async function assertProducts(
  tx: PrismaTransaction,
  ids: string[],
): Promise<void> {
  const found = await tx.product.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true },
  });
  const missing = ids.filter((i) => !found.some((f) => f.id === i));
  if (missing.length)
    throw new BadRequestException(`Products not found: ${missing.join(', ')}`);
}
