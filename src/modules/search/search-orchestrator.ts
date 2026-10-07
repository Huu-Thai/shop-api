import type {
  EngineQuery,
  EngineResult,
  IndexTarget,
  SearchFilters,
  SearchProvider,
} from './search.types.js';

const without = (f: SearchFilters, code: string): SearchFilters => ({
  ...f,
  facets: Object.fromEntries(
    Object.entries(f.facets).filter(([c]) => c !== code),
  ),
});

/**
 * Disjunctive faceting on any engine: the counts of a facet the shopper already filters by are
 * computed without that facet's own filter (so "red" still shows how many blue there are), and the
 * price range ignores the price filter. One extra round trip per active facet.
 */
export async function runSearch(
  provider: SearchProvider,
  target: IndexTarget,
  q: Omit<EngineQuery, 'categoryFacet' | 'priceStats'>,
): Promise<EngineResult> {
  const active = Object.entries(q.filters.facets)
    .filter(([, v]) => v.length)
    .map(([c]) => c);
  const priceFiltered =
    q.filters.priceMin !== undefined || q.filters.priceMax !== undefined;
  const [main, ...extra] = await Promise.all([
    provider.query(target, {
      ...q,
      facetCodes: q.facetCodes.filter((c) => !active.includes(c)),
      categoryFacet: true,
      priceStats: !priceFiltered,
    }),
    ...active
      .filter((c) => q.facetCodes.includes(c))
      .map((code) =>
        provider
          .query(target, {
            ...q,
            filters: without(q.filters, code),
            offset: 0,
            limit: 0,
            facetCodes: [code],
            categoryFacet: false,
            priceStats: false,
          })
          .then((r) => ({ code, r })),
      ),
    ...(priceFiltered
      ? [
          provider
            .query(target, {
              ...q,
              filters: {
                ...q.filters,
                priceMin: undefined,
                priceMax: undefined,
              },
              offset: 0,
              limit: 0,
              facetCodes: [],
              categoryFacet: false,
              priceStats: true,
            })
            .then((r) => ({ code: '', r })),
        ]
      : []),
  ]);
  const result: EngineResult = { ...main, facets: { ...main.facets } };
  for (const e of extra as { code: string; r: EngineResult }[]) {
    if (e.code) {
      if (e.r.facets[e.code]) result.facets[e.code] = e.r.facets[e.code];
    } else result.priceRange = e.r.priceRange;
  }
  return result;
}
