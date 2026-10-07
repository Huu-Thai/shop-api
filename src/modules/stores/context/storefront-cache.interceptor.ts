import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { from, mergeMap, type Observable, of, tap } from 'rxjs';
import type { StorefrontRequest } from './store-context.js';
import {
  ALL_TAG,
  responseTags,
  StorefrontResponseCache,
} from './storefront-response-cache.js';

export const CACHE_TAG_KEY = 'storefront:cacheTag';
export const RESPONSE_CACHE_KEY = 'storefront:responseCache';

export interface ResponseCacheOptions {
  /** Route parameter naming a category: stock changes of its products purge this response. */
  categoryParam?: string;
}

/**
 * Opts a storefront GET into the server-side response cache. Only for responses whose every input
 * change is purged (catalog, prices, stock per product): never content with publishing windows.
 */
export const ResponseCache = (options: ResponseCacheOptions = {}) =>
  SetMetadata(RESPONSE_CACHE_KEY, options);

/**
 * Storefront GETs: short shared caching, Vary on the scope headers, surrogate keys for purges, and
 * a server-side copy for anonymous requests (StorefrontResponseCache).
 */
export const STOREFRONT_CACHE_CONTROL =
  'public, max-age=60, stale-while-revalidate=300';
/** Responses for a signed-in customer (and every account route). */
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

@Injectable()
export class StorefrontCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cache: StorefrontResponseCache,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<StorefrontRequest>();
    const res = http.getResponse<Response>();
    const tag = this.reflector.getAllAndOverride<string | undefined>(
      CACHE_TAG_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const store = req.storeContext;
    const options = this.reflector.getAllAndOverride<
      ResponseCacheOptions | undefined
    >(RESPONSE_CACHE_KEY, [ctx.getHandler(), ctx.getClass()]);
    // Anonymous GETs of opted-in routes only: a signed-in shopper sees their group's prices.
    const cacheable =
      req.method === 'GET' &&
      !!store &&
      !store.customer &&
      !!options &&
      this.cache.enabled;
    const headers = (body: unknown) => {
      if (req.method !== 'GET') return;
      if (store?.customer) {
        res.setHeader('Cache-Control', PRIVATE_CACHE_CONTROL);
        return;
      }
      res.setHeader('Cache-Control', STOREFRONT_CACHE_CONTROL);
      res.setHeader(
        'Vary',
        'X-Store, Accept-Language, X-Currency, Authorization',
      );
      if (store) res.setHeader('Content-Language', store.localeCode);
      const keys = surrogateKeys(tag, body, store?.storeCode);
      if (keys.length) res.setHeader('Surrogate-Key', keys.join(' '));
    };
    if (!cacheable) return next.handle().pipe(tap((body) => headers(body)));

    const param = options.categoryParam
      ? (req.params as Record<string, string> | undefined)?.[
          options.categoryParam
        ]
      : undefined;
    const known = [ALL_TAG, ...(param ? [`category:${param}`] : [])];
    return from(
      Promise.all([
        this.cache.get(store, req.originalUrl),
        this.cache.versions(known).catch(() => known.map(() => null)),
      ]),
    ).pipe(
      mergeMap(([hit, versions]) => {
        if (hit !== undefined) {
          headers(hit);
          res.setHeader('X-Cache', 'HIT');
          return of(hit);
        }
        const before = new Map(known.map((t, i) => [t, versions[i]]));
        return next.handle().pipe(
          tap((body) => {
            headers(body);
            res.setHeader('X-Cache', 'MISS');
            void this.cache.set(
              store,
              req.originalUrl,
              body,
              responseTags(body, known.slice(1)),
              before,
            );
          }),
        );
      }),
    );
  }
}

export function surrogateKeys(
  tag: string | undefined,
  body: unknown,
  storeCode?: string,
): string[] {
  const keys = new Set<string>(storeCode ? [`store:${storeCode}`] : []);
  if (!tag || !body || typeof body !== 'object') return [...keys];
  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : null;
  if (items) keys.add(`${tag}:list`);
  for (const item of items ?? [body]) {
    const id =
      item && typeof item === 'object'
        ? (item as { id?: unknown }).id
        : undefined;
    if (typeof id === 'string') keys.add(`${tag}:${id}`);
  }
  return [...keys].slice(0, 200);
}

/** Account and sign-in routes: responses are personal, never cached anywhere. */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    ctx
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', PRIVATE_CACHE_CONTROL);
    return next.handle();
  }
}
