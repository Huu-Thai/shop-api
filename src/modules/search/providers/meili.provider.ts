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
import { EngineHttp, quote, SearchEngineError } from './http.js';

const auth = (c: SearchConnection): Record<string, string> =>
  c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {};

export function meiliSettings(s: IndexSettings): Record<string, unknown> {
  const synonyms: Record<string, string[]> = {};
  for (const group of s.synonyms)
    for (const word of group) synonyms[word] = group.filter((w) => w !== word);
  return {
    searchableAttributes: [
      'skus',
      'name',
      'attributesText',
      'shortDescription',
      'description',
    ],
    filterableAttributes: [
      'facets',
      'categoryIds',
      'price',
      'inStock',
      'visibility',
      'type',
    ],
    sortableAttributes: ['price', 'nameSort', 'createdAt'],
    synonyms,
    stopWords: s.stopwords,
  };
}

export function meiliFilter(
  f: SearchFilters,
  omitFacet?: string,
  omitPrice = false,
): string[] {
  const out = [`visibility IN [${f.visibility.map(quote).join(', ')}]`];
  if (f.categoryId) out.push(`categoryIds = ${quote(f.categoryId)}`);
  for (const [code, values] of Object.entries(f.facets))
    if (code !== omitFacet && values.length)
      out.push(`facets.${code} IN [${values.map(quote).join(', ')}]`);
  if (!omitPrice && f.priceMin !== undefined)
    out.push(`price >= ${f.priceMin}`);
  if (!omitPrice && f.priceMax !== undefined)
    out.push(`price <= ${f.priceMax}`);
  if (f.inStock !== undefined) out.push(`inStock = ${f.inStock}`);
  return out;
}

const SORT: Record<string, string[]> = {
  price_asc: ['price:asc'],
  price_desc: ['price:desc'],
  name: ['nameSort:asc'],
  newest: ['createdAt:desc'],
};

interface Task {
  taskUid: number;
}

/** Meilisearch ≥ 1.4. Writes are asynchronous tasks; building waits for them. */
export class MeiliProvider implements SearchProvider {
  readonly kind = 'MEILISEARCH' as const;
  private readonly http: EngineHttp;

  constructor(
    conn: SearchConnection,
    fetchImpl?: typeof fetch,
    private readonly pollMs = 100,
  ) {
    this.http = new EngineHttp(conn, auth, fetchImpl);
  }

  async health(): Promise<void> {
    await this.http.request('/health');
    await this.http.request('/indexes?limit=1'); // also checks the key
  }

  /** Waits for a task; `tolerate` lists error codes that count as success (e.g. index_not_found). */
  private async wait(
    task: Task,
    timeoutMs = 120_000,
    tolerate: string[] = [],
  ): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.http.request<{
        status: string;
        error?: { message: string; code?: string };
      }>(`/tasks/${task.taskUid}`);
      if (t.status === 'succeeded') return;
      if (
        t.status === 'failed' &&
        t.error?.code &&
        tolerate.includes(t.error.code)
      )
        return;
      if (t.status === 'failed' || t.status === 'canceled')
        throw new SearchEngineError(
          `Meilisearch task ${task.taskUid} ${t.status}: ${t.error?.message ?? ''}`,
        );
      if (Date.now() > until)
        throw new SearchEngineError(
          `Meilisearch task ${task.taskUid} did not finish in time`,
        );
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async createIndex(t: IndexTarget, s: IndexSettings): Promise<void> {
    // Rebuilding a generation starts from an empty index (a 404 means there was none).
    const dropped = await this.http.request<Partial<Task>>(
      `/indexes/${t.index}`,
      { method: 'DELETE', ok: [404] },
    );
    if (dropped.taskUid !== undefined)
      await this.wait(dropped as Task, 120_000, ['index_not_found']);
    // A concurrent or retried build of the same generation may have created it already: fine,
    // documents are upserts by id.
    await this.wait(
      await this.http.request<Task>('/indexes', {
        body: { uid: t.index, primaryKey: 'id' },
      }),
      120_000,
      ['index_already_exists'],
    );
    await this.wait(
      await this.http.request<Task>(`/indexes/${t.index}/settings`, {
        method: 'PATCH',
        body: meiliSettings(s),
      }),
    );
  }

  async index(
    t: IndexTarget,
    docs: SearchDocumentBody[],
    wait = false,
  ): Promise<void> {
    if (!docs.length) return;
    const task = await this.http.request<Task>(
      `/indexes/${t.index}/documents?primaryKey=id`,
      { body: docs, timeoutMs: 60_000 },
    );
    if (wait) await this.wait(task);
  }

  async remove(t: IndexTarget, ids: string[]): Promise<void> {
    if (ids.length)
      await this.http.request<Task>(
        `/indexes/${t.index}/documents/delete-batch`,
        { body: ids },
      );
  }

  async dropIndex(t: IndexTarget): Promise<void> {
    await this.http.request(`/indexes/${t.index}`, {
      method: 'DELETE',
      ok: [404],
    });
  }

  async query(t: IndexTarget, q: EngineQuery): Promise<EngineResult> {
    const facets = [
      ...q.facetCodes.map((c) => `facets.${c}`),
      ...(q.categoryFacet ? ['categoryIds'] : []),
      ...(q.priceStats ? ['price'] : []),
    ];
    const res = await this.http.request<{
      hits: { id: string }[];
      totalHits: number;
      facetDistribution?: Record<string, Record<string, number>>;
      facetStats?: Record<string, { min: number; max: number }>;
    }>(`/indexes/${t.index}/search`, {
      body: {
        q: q.text,
        filter: meiliFilter(q.filters),
        page: Math.floor(q.offset / Math.max(q.limit, 1)) + 1,
        hitsPerPage: q.limit,
        attributesToRetrieve: ['id'],
        facets,
        ...(q.sort !== 'relevance'
          ? { sort: SORT[q.sort] }
          : !q.text.trim()
            ? { sort: SORT.newest }
            : {}),
      },
    });
    const out: EngineResult['facets'] = {};
    for (const [key, dist] of Object.entries(res.facetDistribution ?? {})) {
      if (!Object.keys(dist).length || key === 'price') continue;
      out[key === 'categoryIds' ? 'category' : key.replace(/^facets\./, '')] =
        dist;
    }
    const p = res.facetStats?.price;
    return {
      ids: res.hits.map((h) => h.id),
      total: res.totalHits,
      facets: out,
      priceRange: p ? { min: p.min, max: p.max } : null,
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
      hits: { id: string; name: string }[];
    }>(`/indexes/${t.index}/search`, {
      body: {
        q: text,
        limit,
        filter: [`visibility IN [${visibility.map(quote).join(', ')}]`],
        attributesToRetrieve: ['id', 'name'],
        attributesToSearchOn: ['name'],
      },
    });
    return res.hits.map((h) => ({ id: h.id, name: h.name }));
  }
}
