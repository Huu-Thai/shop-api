import type { ProductVisibility } from '../../../database/generated/prisma/client.js';
import type {
  EngineQuery,
  EngineResult,
  IndexSettings,
  IndexTarget,
  SearchConnection,
  SearchDocumentBody,
  SearchFilters,
  SearchProvider,
  Suggestion,
} from '../search.types.js';
import { stemmerFor } from './analysis.js';
import { EngineHttp } from './http.js';

type Obj = Record<string, unknown>;

const auth = (c: SearchConnection): Record<string, string> =>
  c.apiKey
    ? { authorization: `ApiKey ${c.apiKey}` }
    : c.username
      ? {
          authorization: `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')}`,
        }
      : {};

/** Index settings: accent folding, per-language stemming, search-time synonyms. */
export function elasticIndexBody(s: IndexSettings): Obj {
  const stemmer = stemmerFor(s.localeCode);
  const base = [
    'lowercase',
    'asciifolding',
    ...(s.stopwords.length ? ['shop_stop'] : []),
    ...(stemmer ? ['shop_stemmer'] : []),
  ];
  return {
    settings: {
      analysis: {
        filter: {
          shop_edge: { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
          ...(stemmer
            ? { shop_stemmer: { type: 'stemmer', language: stemmer } }
            : {}),
          ...(s.stopwords.length
            ? { shop_stop: { type: 'stop', stopwords: s.stopwords } }
            : {}),
          ...(s.synonyms.length
            ? {
                shop_synonyms: {
                  type: 'synonym_graph',
                  synonyms: s.synonyms.map((g) => g.join(', ')),
                },
              }
            : {}),
        },
        analyzer: {
          shop_index: { type: 'custom', tokenizer: 'standard', filter: base },
          shop_search: {
            type: 'custom',
            tokenizer: 'standard',
            filter: [
              'lowercase',
              'asciifolding',
              ...(s.synonyms.length ? ['shop_synonyms'] : []),
              ...base.slice(2),
            ],
          },
          shop_prefix: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding', 'shop_edge'],
          },
        },
      },
    },
    mappings: {
      dynamic_templates: [
        { facets: { path_match: 'facets.*', mapping: { type: 'keyword' } } },
      ],
      properties: {
        id: { type: 'keyword' },
        type: { type: 'keyword' },
        name: {
          type: 'text',
          analyzer: 'shop_index',
          search_analyzer: 'shop_search',
          fields: {
            prefix: {
              type: 'text',
              analyzer: 'shop_prefix',
              search_analyzer: 'shop_search',
            },
          },
        },
        nameSort: { type: 'keyword' },
        sku: { type: 'keyword' },
        skus: { type: 'keyword' },
        shortDescription: {
          type: 'text',
          analyzer: 'shop_index',
          search_analyzer: 'shop_search',
        },
        description: {
          type: 'text',
          analyzer: 'shop_index',
          search_analyzer: 'shop_search',
        },
        attributesText: {
          type: 'text',
          analyzer: 'shop_index',
          search_analyzer: 'shop_search',
        },
        categoryIds: { type: 'keyword' },
        price: { type: 'long' },
        inStock: { type: 'boolean' },
        visibility: { type: 'keyword' },
        createdAt: { type: 'long' },
      },
    },
  };
}

export function elasticFilters(
  f: SearchFilters,
  omitFacet?: string,
  omitPrice = false,
): Obj[] {
  const out: Obj[] = [{ terms: { visibility: [...f.visibility] } }];
  if (f.categoryId) out.push({ term: { categoryIds: f.categoryId } });
  for (const [code, values] of Object.entries(f.facets))
    if (code !== omitFacet && values.length)
      out.push({ terms: { [`facets.${code}`]: values } });
  if (!omitPrice && (f.priceMin !== undefined || f.priceMax !== undefined))
    out.push({
      range: {
        price: {
          ...(f.priceMin !== undefined ? { gte: f.priceMin } : {}),
          ...(f.priceMax !== undefined ? { lte: f.priceMax } : {}),
        },
      },
    });
  if (f.inStock !== undefined) out.push({ term: { inStock: f.inStock } });
  return out;
}

export function elasticTextQuery(text: string): Obj {
  const q = text.trim();
  if (!q) return { match_all: {} };
  return {
    bool: {
      should: [
        { term: { skus: { value: q.toUpperCase(), boost: 10 } } },
        {
          multi_match: {
            query: q,
            fields: [
              'name^4',
              'attributesText^2',
              'shortDescription^2',
              'description',
            ],
            fuzziness: 'AUTO',
            operator: 'and',
          },
        },
        { match: { 'name.prefix': { query: q, operator: 'and', boost: 2 } } },
      ],
      minimum_should_match: 1,
    },
  };
}

const SORT: Record<string, Obj[]> = {
  price_asc: [{ price: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
  price_desc: [{ price: { order: 'desc', missing: '_last' } }, { id: 'asc' }],
  name: [{ nameSort: 'asc' }, { id: 'asc' }],
  newest: [{ createdAt: 'desc' }, { id: 'asc' }],
};

/** Elasticsearch 8 and OpenSearch 2 (the APIs used here are identical). */
export class ElasticLikeProvider implements SearchProvider {
  private readonly http: EngineHttp;

  constructor(
    readonly kind: 'ELASTICSEARCH' | 'OPENSEARCH',
    conn: SearchConnection,
    fetchImpl?: typeof fetch,
  ) {
    this.http = new EngineHttp(conn, auth, fetchImpl);
  }

  async health(): Promise<void> {
    await this.http.request('/_cluster/health');
  }

  async createIndex(t: IndexTarget, s: IndexSettings): Promise<void> {
    await this.http.request(`/${t.index}`, { method: 'DELETE', ok: [404] });
    await this.http.request(`/${t.index}`, {
      method: 'PUT',
      body: elasticIndexBody(s),
    });
  }

  async index(
    t: IndexTarget,
    docs: SearchDocumentBody[],
    wait = false,
  ): Promise<void> {
    if (!docs.length) return;
    const raw = docs
      .map(
        (d) =>
          `${JSON.stringify({ index: { _index: t.index, _id: d.id } })}\n${JSON.stringify(d)}\n`,
      )
      .join('');
    const res = await this.http.request<{
      errors: boolean;
      items: { index?: { error?: unknown } }[];
    }>(`/_bulk${wait ? '?refresh=wait_for' : ''}`, {
      raw,
      contentType: 'application/x-ndjson',
      timeoutMs: 60_000,
    });
    if (res.errors)
      throw new Error(
        `Bulk indexing failed: ${JSON.stringify(res.items.find((i) => i.index?.error)?.index?.error).slice(0, 300)}`,
      );
  }

  async remove(t: IndexTarget, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const raw = ids
      .map(
        (id) => `${JSON.stringify({ delete: { _index: t.index, _id: id } })}\n`,
      )
      .join('');
    await this.http.request('/_bulk', {
      raw,
      contentType: 'application/x-ndjson',
    });
  }

  async dropIndex(t: IndexTarget): Promise<void> {
    await this.http.request(`/${t.index}`, { method: 'DELETE', ok: [404] });
  }

  async query(t: IndexTarget, q: EngineQuery): Promise<EngineResult> {
    const aggs: Obj = {};
    for (const code of q.facetCodes)
      aggs[`f_${code}`] = { terms: { field: `facets.${code}`, size: 200 } };
    if (q.categoryFacet)
      aggs.f_category = { terms: { field: 'categoryIds', size: 500 } };
    if (q.priceStats) aggs.price = { stats: { field: 'price' } };
    const res = await this.http.request<{
      hits: { total: { value: number }; hits: { _id: string }[] };
      aggregations?: Record<
        string,
        {
          buckets?: {
            key: string | number;
            key_as_string?: string;
            doc_count: number;
          }[];
          min?: number | null;
          max?: number | null;
        }
      >;
    }>(`/${t.index}/_search`, {
      body: {
        query: {
          bool: {
            must: [elasticTextQuery(q.text)],
            filter: elasticFilters(q.filters),
          },
        },
        from: q.offset,
        size: q.limit,
        track_total_hits: true,
        _source: false,
        ...(q.sort !== 'relevance' || !q.text.trim()
          ? { sort: SORT[q.sort === 'relevance' ? 'newest' : q.sort] }
          : {}),
        aggs,
      },
    });
    const facets: EngineResult['facets'] = {};
    for (const [key, agg] of Object.entries(res.aggregations ?? {}))
      if (key.startsWith('f_') && agg.buckets?.length)
        facets[key.slice(2)] = Object.fromEntries(
          agg.buckets.map((b) => [
            b.key_as_string ?? String(b.key),
            b.doc_count,
          ]),
        );
    const p = res.aggregations?.price;
    return {
      ids: res.hits.hits.map((h) => h._id),
      total: res.hits.total.value,
      facets,
      priceRange:
        p && p.min != null && p.max != null ? { min: p.min, max: p.max } : null,
    };
  }

  async suggest(
    t: IndexTarget,
    text: string,
    visibility: readonly ProductVisibility[],
    limit: number,
  ): Promise<Suggestion[]> {
    if (!text.trim()) return [];
    const res = await this.http.request<{
      hits: { hits: { _id: string; _source: { name: string } }[] };
    }>(`/${t.index}/_search`, {
      body: {
        query: {
          bool: {
            must: [
              { match: { 'name.prefix': { query: text, operator: 'and' } } },
            ],
            filter: [{ terms: { visibility: [...visibility] } }],
          },
        },
        size: limit,
        _source: ['name'],
      },
    });
    return res.hits.hits.map((h) => ({ id: h._id, name: h._source.name }));
  }
}
