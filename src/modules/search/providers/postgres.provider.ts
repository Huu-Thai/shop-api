import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type ProductVisibility,
} from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { terms } from '../search-text.js';
import type {
  EngineQuery,
  EngineResult,
  IndexTarget,
  SearchDocumentBody,
  SearchFilters,
  SearchProvider,
  Suggestion,
} from '../search.types.js';

/**
 * `tee shi` → `tee & shi:*` (all words, the last one as a prefix — search as you type). Single-word
 * synonyms widen a term: with [["tee", "singlet"]], `singlet` becomes `(singlet | tee)`.
 */
export function prefixQuery(
  text: string,
  synonyms: readonly string[][] = [],
): string | null {
  const t = terms(text);
  if (!t.length) return null;
  return t
    .map((w, i) => {
      const alts = [
        ...new Set(
          synonyms
            .filter((g) => g.includes(w))
            .flatMap((g) => g.flatMap((x) => terms(x)))
            .filter((x) => x !== w),
        ),
      ];
      const self = i === t.length - 1 ? `${w}:*` : w;
      return alts.length ? `(${[self, ...alts].join(' | ')})` : self;
    })
    .join(' & ');
}

/** WHERE fragments for the filters (documents of one store/locale). */
export function filterSql(
  f: SearchFilters,
  omitFacet?: string,
  omitPrice = false,
): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [
    Prisma.sql`d.document->>'visibility' = ANY (${[...f.visibility]})`,
  ];
  if (f.categoryId)
    parts.push(Prisma.sql`d.document->'categoryIds' ? ${f.categoryId}`);
  for (const [code, values] of Object.entries(f.facets))
    if (code !== omitFacet && values.length)
      parts.push(
        Prisma.sql`d.document->'facets'->${code} ?| ${values}::text[]`,
      );
  if (!omitPrice && f.priceMin !== undefined)
    parts.push(Prisma.sql`(d.document->>'price')::bigint >= ${f.priceMin}`);
  if (!omitPrice && f.priceMax !== undefined)
    parts.push(Prisma.sql`(d.document->>'price')::bigint <= ${f.priceMax}`);
  if (f.inStock !== undefined)
    parts.push(Prisma.sql`(d.document->>'inStock')::boolean = ${f.inStock}`);
  return parts;
}

const ORDER: Record<string, Prisma.Sql> = {
  price_asc: Prisma.sql`(d.document->>'price')::bigint ASC NULLS LAST, d.entity_id`,
  price_desc: Prisma.sql`(d.document->>'price')::bigint DESC NULLS LAST, d.entity_id`,
  name: Prisma.sql`d.document->>'nameSort' COLLATE "und-x-icu", d.entity_id`,
  newest: Prisma.sql`(d.document->>'createdAt')::bigint DESC, d.entity_id`,
};

/**
 * The default engine: full text over `search_documents` (weighted tsvector, per-locale stemming,
 * accent-insensitive), JSONB filters (GIN), and facet counts by GROUP BY. Documents are written by
 * the SearchIndexer, so index/remove/createIndex are no-ops here.
 */
@Injectable()
export class PostgresSearchProvider implements SearchProvider {
  readonly kind = 'POSTGRES' as const;

  constructor(private readonly prisma: PrismaService) {}

  async createIndex(): Promise<void> {}
  async index(_t: IndexTarget, _docs: SearchDocumentBody[]): Promise<void> {}
  async remove(): Promise<void> {}
  async dropIndex(): Promise<void> {}

  async health(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  private base(
    t: IndexTarget,
    text: string,
    filters: Prisma.Sql[],
    synonyms?: string[][],
  ): Prisma.Sql {
    const q = prefixQuery(text, synonyms);
    const match = q
      ? Prisma.sql`AND (d.search_vector @@ to_tsquery(shop_search_config(${t.localeCode}), ${q}) OR d.document->'skus' ? ${text.trim().toUpperCase()})`
      : Prisma.empty;
    return Prisma.sql`FROM search_documents d
      WHERE d.store_id = ${t.storeId}::uuid AND d.locale_code = ${t.localeCode} AND d.entity_type = 'PRODUCT'
        AND ${Prisma.join(filters, ' AND ')} ${match}`;
  }

  async query(t: IndexTarget, q: EngineQuery): Promise<EngineResult> {
    const filters = filterSql(q.filters);
    const tsq = prefixQuery(q.text, q.synonyms);
    const order =
      q.sort === 'relevance'
        ? tsq
          ? Prisma.sql`ts_rank_cd(d.search_vector, to_tsquery(shop_search_config(${t.localeCode}), ${tsq})) DESC, d.entity_id`
          : ORDER.newest
        : ORDER[q.sort];
    const from = this.base(t, q.text, filters, q.synonyms);
    const [rows, facets, priceRange] = await Promise.all([
      q.limit
        ? this.prisma.$queryRaw<
            { id: string; total: bigint }[]
          >`SELECT d.entity_id AS id, count(*) OVER () AS total ${from} ORDER BY ${order} LIMIT ${q.limit} OFFSET ${q.offset}`
        : Promise.resolve([]),
      this.facets(
        t,
        q.text,
        filters,
        q.facetCodes,
        q.categoryFacet,
        q.synonyms,
      ),
      q.priceStats
        ? this.prisma.$queryRaw<{ min: bigint | null; max: bigint | null }[]>`
            SELECT min((d.document->>'price')::bigint) AS min, max((d.document->>'price')::bigint) AS max ${from}`
        : Promise.resolve([]),
    ]);
    const total = q.limit
      ? Number(rows[0]?.total ?? 0)
      : Number(
          (
            await this.prisma.$queryRaw<
              { n: bigint }[]
            >`SELECT count(*) AS n ${from}`
          )[0].n,
        );
    const pr = priceRange[0];
    return {
      ids: rows.map((r) => r.id),
      total,
      facets,
      priceRange:
        pr && pr.min !== null && pr.max !== null
          ? { min: Number(pr.min), max: Number(pr.max) }
          : null,
    };
  }

  private async facets(
    t: IndexTarget,
    text: string,
    filters: Prisma.Sql[],
    codes: string[],
    category: boolean,
    synonyms?: string[][],
  ) {
    const out: Record<string, Record<string, number>> = {};
    const from = this.base(t, text, filters, synonyms);
    const fields: [string, Prisma.Sql][] = [
      ...codes.map(
        (c) => [c, Prisma.sql`x.doc->'facets'->${c}`] as [string, Prisma.Sql],
      ),
      ...(category
        ? [
            ['category', Prisma.sql`x.doc->'categoryIds'`] as [
              string,
              Prisma.Sql,
            ],
          ]
        : []),
    ];
    await Promise.all(
      fields.map(async ([code, path]) => {
        const rows = await this.prisma.$queryRaw<{ v: string; n: bigint }[]>`
          SELECT v, count(*) AS n
            FROM (SELECT d.document AS doc ${from}) x
           CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END) v
           GROUP BY v`;
        if (rows.length)
          out[code] = Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]));
      }),
    );
    return out;
  }

  async suggest(
    t: IndexTarget,
    text: string,
    visibility: readonly ProductVisibility[],
    limit: number,
  ): Promise<Suggestion[]> {
    const q = prefixQuery(text);
    if (!q) return [];
    const rows = await this.prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT d.entity_id AS id, d.document->>'name' AS name
        FROM search_documents d
       WHERE d.store_id = ${t.storeId}::uuid AND d.locale_code = ${t.localeCode} AND d.entity_type = 'PRODUCT'
         AND d.document->>'visibility' = ANY (${[...visibility]})
         AND d.search_vector @@ to_tsquery(shop_search_config(${t.localeCode}), ${q})
       ORDER BY ts_rank_cd(d.search_vector, to_tsquery(shop_search_config(${t.localeCode}), ${q})) DESC, d.document->>'nameSort'
       LIMIT ${limit}`;
    return rows;
  }
}
