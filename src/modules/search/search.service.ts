import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { ProductVisibility } from '../../database/generated/prisma/client.js';
import { AttributesQuery } from '../catalog/attributes.query.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import {
  StorefrontCatalogService,
  parseFilters,
} from '../storefront/storefront-catalog.service.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { StoresQuery } from '../stores/stores.query.js';
import { UrlRewritesQuery } from '../url-rewrites/url-rewrites.query.js';
import type {
  SearchQueryDto,
  StorefrontSearchResultDto,
  StorefrontSuggestionDto,
  SuggestQueryDto,
} from './dto/search-storefront.dto.js';
import { SearchProviders } from './providers/registry.js';
import { runSearch } from './search-orchestrator.js';
import {
  type EngineRef,
  SearchSettingsQuery,
} from './search-settings.query.js';
import {
  BROWSE_VISIBILITY,
  type EngineResult,
  indexName,
  type IndexTarget,
  SEARCH_VISIBILITY,
  type SearchProvider,
} from './search.types.js';

const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 30_000;

/** Opens after repeated failures of an engine; requests then go straight to the Postgres fallback. */
export class CircuitBreaker {
  private readonly state = new Map<
    string,
    { failures: number; openUntil: number }
  >();

  isOpen(key: string, now = Date.now()): boolean {
    return (this.state.get(key)?.openUntil ?? 0) > now;
  }

  success(key: string): void {
    this.state.delete(key);
  }

  failure(key: string, now = Date.now()): void {
    const s = this.state.get(key) ?? { failures: 0, openUntil: 0 };
    s.failures++;
    if (s.failures >= BREAKER_FAILURES) s.openUntil = now + BREAKER_OPEN_MS;
    this.state.set(key, s);
  }
}

/** Storefront search (PLAN.md §9.5): the website's engine, with Postgres as the fallback. */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  readonly breaker = new CircuitBreaker();

  constructor(
    private readonly settings: SearchSettingsQuery,
    private readonly providers: SearchProviders,
    private readonly attributes: AttributesQuery,
    private readonly categories: CategoriesQuery,
    private readonly storefront: StorefrontCatalogService,
    private readonly stores: StoresQuery,
    private readonly urls: UrlRewritesQuery,
  ) {}

  private async engine(ctx: StoreContext): Promise<{
    provider: SearchProvider;
    target: IndexTarget;
    key: string;
    synonyms: string[][];
  }> {
    const s = await this.settings.effective(ctx.websiteId);
    const ref: EngineRef = s.active;
    return {
      provider:
        ref.provider === 'POSTGRES'
          ? this.providers.postgres
          : this.providers.for(ref),
      target: {
        storeId: ctx.storeId,
        storeCode: ctx.storeCode,
        localeCode: ctx.localeCode,
        index: indexName(
          s.prefix,
          ref.generation,
          ctx.storeCode,
          ctx.localeCode,
        ),
      },
      key: `${ctx.websiteId}|${ref.provider}|${ref.generation}`,
      synonyms: s.synonyms,
    };
  }

  /** Runs on the active engine; on failure (or an open breaker) answers from Postgres. */
  private async withFallback<T>(
    ctx: StoreContext,
    run: (
      p: SearchProvider,
      t: IndexTarget,
      synonyms: string[][],
    ) => Promise<T>,
    onEngine?: (kind: string) => void,
  ): Promise<T> {
    const { provider, target, key, synonyms } = await this.engine(ctx);
    const fallback = () => {
      onEngine?.(
        provider.kind === 'POSTGRES' ? 'POSTGRES' : 'POSTGRES-FALLBACK',
      );
      return run(this.providers.postgres, target, synonyms);
    };
    if (provider.kind === 'POSTGRES' || this.breaker.isOpen(key))
      return fallback();
    try {
      const r = await run(provider, target, synonyms);
      this.breaker.success(key);
      onEngine?.(provider.kind);
      return r;
    } catch (e) {
      this.breaker.failure(key);
      this.logger.warn(
        `Search engine ${provider.kind} failed (${(e as Error).message}); answering from Postgres`,
      );
      return fallback();
    }
  }

  /** `onEngine` reports which engine answered (X-Search-Engine header). */
  async search(
    ctx: StoreContext,
    q: SearchQueryDto,
    onEngine?: (kind: string) => void,
  ): Promise<StorefrontSearchResultDto> {
    if (
      q.priceMin !== undefined &&
      q.priceMax !== undefined &&
      q.priceMin > q.priceMax
    )
      throw new BadRequestException('priceMin must not exceed priceMax');
    const text = (q.q ?? '').trim();
    const filters = parseFilters(q.filter);
    const { filterable } = await this.attributes.searchCodes();
    const unknown = Object.keys(filters).filter((c) => !filterable.includes(c));
    if (unknown.length)
      throw new BadRequestException(`Not filterable: ${unknown.join(', ')}`);
    const visibility: readonly ProductVisibility[] = text
      ? SEARCH_VISIBILITY
      : BROWSE_VISIBILITY;
    const result: EngineResult = await this.withFallback(
      ctx,
      (p, t, synonyms) =>
        runSearch(p, t, {
          synonyms,
          text,
          filters: {
            categoryId: q.category,
            facets: filters,
            priceMin: q.priceMin,
            priceMax: q.priceMax,
            inStock: q.inStock,
            visibility,
          },
          sort: q.sort,
          offset: (q.page - 1) * q.limit,
          limit: q.limit,
          facetCodes: filterable,
        }),
      onEngine,
    );
    const facetCodes = Object.keys(result.facets).filter(
      (c) => c !== 'category',
    );
    const [cards, labels, visible, snap] = await Promise.all([
      this.storefront.cards(ctx, result.ids),
      this.attributes.localized(facetCodes, ctx.localeChain),
      this.categories.visible(ctx.websiteId, ctx.localeChain),
      this.stores.snapshot(),
    ]);
    return {
      data: cards,
      total: result.total,
      page: q.page,
      limit: q.limit,
      facets: facetCodes
        .filter((c) => labels.has(c))
        .map((code) => {
          const attr = labels.get(code)!;
          return {
            code,
            label: attr.label,
            values: Object.entries(result.facets[code])
              .map(([value, count]) => ({
                value,
                label:
                  attr.options.get(value)?.label ??
                  (attr.def.type === 'BOOLEAN'
                    ? value === 'true'
                      ? 'Yes'
                      : 'No'
                    : value),
                count,
                swatch: attr.options.get(value)?.swatch ?? null,
                selected: filters[code]?.includes(value) ?? false,
                position: attr.options.get(value)?.position ?? 0,
              }))
              .sort(
                (a, b) =>
                  a.position - b.position || a.label.localeCompare(b.label),
              )
              .map(({ position: _p, ...v }) => v),
          };
        })
        .sort(
          (a, b) =>
            labels.get(a.code)!.def.position -
              labels.get(b.code)!.def.position || a.code.localeCompare(b.code),
        ),
      categories: Object.entries(result.facets.category ?? {})
        .filter(([id]) => visible.has(id))
        .map(([id, count]) => ({
          id,
          name: visible.get(id)!.name,
          parentId: visible.get(id)!.parentId,
          count,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      priceRange: result.priceRange
        ? {
            ...result.priceRange,
            currency:
              snap.byId.get(ctx.storeId)?.defaultCurrencyCode ??
              ctx.currencyCode,
          }
        : null,
    };
  }

  async suggest(
    ctx: StoreContext,
    q: SuggestQueryDto,
  ): Promise<StorefrontSuggestionDto[]> {
    const hits = await this.withFallback(ctx, (p, t) =>
      p.suggest(t, q.q, SEARCH_VISIBILITY, q.limit),
    );
    const paths = await this.urls.canonicalPaths(
      ctx,
      'PRODUCT',
      hits.map((h) => h.id),
    );
    return hits.map((h) => ({ ...h, urlPath: paths.get(h.id) ?? null }));
  }
}
