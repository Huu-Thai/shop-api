import type {
  ProductType,
  ProductVisibility,
  SearchProviderKind,
} from '../../database/generated/prisma/client.js';

/** One searchable product in one store and locale — identical for every engine. */
export interface SearchDocumentBody {
  id: string;
  type: ProductType;
  name: string;
  /** Unaccented, lower-case name for sorting. */
  nameSort: string;
  sku: string;
  skus: string[];
  shortDescription: string;
  description: string;
  /** Searchable attribute values (localized labels). */
  attributesText: string;
  /** The product's categories and all their ancestors. */
  categoryIds: string[];
  /** Filterable attribute code → option codes (`true`/`false` for booleans). */
  facets: Record<string, string[]>;
  /** Displayed "from" price in the store's default currency (guest group); null when not priced. */
  price: number | null;
  inStock: boolean;
  visibility: ProductVisibility;
  createdAt: number;
}

export type SearchSort =
  'relevance' | 'price_asc' | 'price_desc' | 'name' | 'newest';

export interface SearchFilters {
  categoryId?: string;
  /** code → accepted option codes (OR within a facet, AND across facets) */
  facets: Record<string, string[]>;
  priceMin?: number;
  priceMax?: number;
  inStock?: boolean;
  visibility: readonly ProductVisibility[];
}

/** One engine round trip: results plus counts for the requested facets under these filters. */
export interface EngineQuery {
  text: string;
  filters: SearchFilters;
  sort: SearchSort;
  offset: number;
  limit: number;
  facetCodes: string[];
  /** Synonym groups (engines with index-level synonyms ignore this; Postgres expands terms). */
  synonyms?: string[][];
  /** Count categories (facet `category`). */
  categoryFacet: boolean;
  priceStats: boolean;
}

export interface EngineResult {
  ids: string[];
  total: number;
  /** code → value → count ('category' holds category ids) */
  facets: Record<string, Record<string, number>>;
  priceRange: { min: number; max: number } | null;
}

export interface Suggestion {
  id: string;
  name: string;
}

/** Where a store/locale's documents live in an engine. */
export interface IndexTarget {
  storeId: string;
  storeCode: string;
  localeCode: string;
  /** Engine index name (external engines); Postgres ignores it. */
  index: string;
}

export interface IndexSettings {
  localeCode: string;
  synonyms: string[][];
  stopwords: string[];
}

export interface SearchConnection {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

/** PLAN.md §9.5 — every engine implements the same contract. */
export interface SearchProvider {
  readonly kind: SearchProviderKind;
  /** Creates (or recreates) an index with mappings/settings for the locale. */
  createIndex(target: IndexTarget, settings: IndexSettings): Promise<void>;
  /** Upserts documents; `wait` blocks until they are searchable (used while building). */
  index(
    target: IndexTarget,
    docs: SearchDocumentBody[],
    wait?: boolean,
  ): Promise<void>;
  remove(target: IndexTarget, ids: string[]): Promise<void>;
  dropIndex(target: IndexTarget): Promise<void>;
  query(target: IndexTarget, q: EngineQuery): Promise<EngineResult>;
  suggest(
    target: IndexTarget,
    text: string,
    visibility: readonly ProductVisibility[],
    limit: number,
  ): Promise<Suggestion[]>;
  health(): Promise<void>;
}

/** `shop_g3_vn-vi_vi_vn` style names: prefix, generation, store and locale (lower case, engine-safe). */
export function indexName(
  prefix: string,
  generation: number,
  storeCode: string,
  localeCode: string,
): string {
  return `${prefix}_g${generation}_${storeCode}_${localeCode}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

export const SEARCH_VISIBILITY: readonly ProductVisibility[] = [
  'SEARCH',
  'CATALOG_SEARCH',
];
export const BROWSE_VISIBILITY: readonly ProductVisibility[] = [
  'CATALOG',
  'CATALOG_SEARCH',
];
