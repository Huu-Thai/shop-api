import type { Prisma } from '../../database/generated/prisma/client.js';
import { type ProductDto, RELATION_KEYS } from './dto/product-view.dto.js';

/** Full admin view of a product. */
export const PRODUCT_SELECT = {
  id: true,
  sku: true,
  type: true,
  status: true,
  visibility: true,
  attributeSetId: true,
  attributes: true,
  typeOptions: true,
  weightGrams: true,
  taxClassId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  translations: {
    select: {
      localeCode: true,
      name: true,
      slug: true,
      shortDescription: true,
      description: true,
      metaTitle: true,
      metaDescription: true,
      attributes: true,
    },
    orderBy: { localeCode: 'asc' },
  },
  websites: { select: { websiteId: true } },
  categories: {
    select: { categoryId: true, position: true },
    orderBy: { categoryId: 'asc' },
  },
  configurableAttributes: {
    select: { attribute: { select: { code: true } } },
    orderBy: { position: 'asc' },
  },
  variants: {
    select: {
      id: true,
      sku: true,
      optionValues: true,
      isDefault: true,
      status: true,
      weightGrams: true,
      position: true,
    },
    orderBy: [{ position: 'asc' }, { sku: 'asc' }],
  },
  bundleOptions: {
    select: {
      id: true,
      code: true,
      inputType: true,
      isRequired: true,
      position: true,
      translations: {
        select: { localeCode: true, title: true },
        orderBy: { localeCode: 'asc' },
      },
      selections: {
        select: {
          id: true,
          variantId: true,
          qty: true,
          canChangeQty: true,
          isDefault: true,
          position: true,
          variant: { select: { sku: true } },
        },
        orderBy: { position: 'asc' },
      },
    },
    orderBy: { position: 'asc' },
  },
  storeOverrides: {
    select: { storeId: true, status: true, visibility: true, attributes: true },
    orderBy: { storeId: 'asc' },
  },
  relations: {
    select: { relatedProductId: true, type: true },
    orderBy: { position: 'asc' },
  },
} as const satisfies Prisma.ProductSelect;

export type ProductRow = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_SELECT;
}>;
type Json = Record<string, unknown>;

export function toProductDto(p: ProductRow): ProductDto {
  const relations: ProductDto['relations'] = {
    related: [],
    upsell: [],
    crossSell: [],
  };
  for (const r of p.relations)
    relations[RELATION_KEYS[r.type]].push(r.relatedProductId);
  return {
    ...p,
    attributes: p.attributes as Json,
    typeOptions: p.typeOptions as Json,
    translations: p.translations.map((t) => ({
      ...t,
      attributes: t.attributes as Json,
    })),
    websiteIds: p.websites.map((w) => w.websiteId).sort(),
    configurableAttributes: p.configurableAttributes.map(
      (c) => c.attribute.code,
    ),
    variants: p.variants.map((v) => ({
      ...v,
      optionValues: v.optionValues as Record<string, string>,
    })),
    bundleOptions: p.bundleOptions.map(
      ({ translations, selections, ...o }) => ({
        ...o,
        titles: translations,
        selections: selections.map(({ variant, ...s }) => ({
          ...s,
          variantSku: variant.sku,
        })),
      }),
    ),
    storeOverrides: p.storeOverrides.map((o) => ({
      ...o,
      attributes: o.attributes as Json,
    })),
    relations,
  };
}
