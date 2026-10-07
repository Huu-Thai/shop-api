import type { LocalizedAttribute } from '../catalog/attributes.query.js';
import type { ProductViewRow } from '../products/products.query.js';
import { fold, plainText } from './search-text.js';
import type { SearchDocumentBody } from './search.types.js';

const facetValue = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === 'boolean'
      ? [String(v)]
      : v === undefined || v === null
        ? []
        : [String(v)];

/**
 * The engine-neutral document for one product in one store/locale. Facets combine the product's
 * own option values and those of its enabled variants (a red M tee is found by color=red).
 */
export function buildDocument(
  view: ProductViewRow,
  offer: { price: number | null; inStock: boolean },
  attrs: ReadonlyMap<string, LocalizedAttribute>,
  categoryIds: readonly string[],
): SearchDocumentBody {
  const facets: Record<string, string[]> = {};
  const words: string[] = [];
  for (const [code, attr] of attrs) {
    const values = new Set<string>(facetValue(view.attributes[code]));
    for (const v of view.variants)
      if (v.optionValues[code]) values.add(v.optionValues[code]);
    if (!values.size) continue;
    if (
      attr.def.isFilterable &&
      ['SELECT', 'MULTISELECT', 'BOOLEAN'].includes(attr.def.type)
    )
      facets[code] = [...values].sort();
    if (attr.def.isSearchable)
      words.push(
        ...[...values].map((v) =>
          attr.def.type === 'SELECT' || attr.def.type === 'MULTISELECT'
            ? (attr.options.get(v)?.label ?? v)
            : v,
        ),
      );
  }
  return {
    id: view.id,
    type: view.type,
    name: view.name,
    nameSort: fold(view.name),
    sku: view.sku,
    skus: [...new Set([view.sku, ...view.variants.map((v) => v.sku)])].map(
      (s) => s.toUpperCase(),
    ),
    shortDescription: plainText(view.shortDescription, 1000),
    description: plainText(view.description),
    attributesText: words.join(' ').slice(0, 2000),
    categoryIds: [...new Set(categoryIds)],
    facets,
    price: offer.price,
    inStock: offer.inStock,
    visibility: view.visibility,
    createdAt: view.createdAt.getTime(),
  };
}

/** Weighted text for the Postgres tsvector: A = names and SKUs, B = attributes and summary, C = description. */
export function weightedText(d: SearchDocumentBody): {
  a: string;
  b: string;
  c: string;
} {
  return {
    a: `${d.name} ${d.skus.join(' ')}`,
    b: `${d.attributesText} ${d.shortDescription}`,
    c: d.description,
  };
}
