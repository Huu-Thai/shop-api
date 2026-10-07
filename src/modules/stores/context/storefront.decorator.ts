import {
  applyDecorators,
  SetMetadata,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/decorators/auth.decorators.js';
import {
  CACHE_TAG_KEY,
  NoStoreInterceptor,
  StorefrontCacheInterceptor,
} from './storefront-cache.interceptor.js';
import {
  CURRENCY_HEADER,
  CustomerRequiredGuard,
  IGNORE_CUSTOMER_TOKEN,
  STORE_HEADER,
  StoreContextGuard,
} from './store-context.guard.js';

/**
 * A public, store-scoped storefront controller (`/api/v1/store/*`): resolves the StoreContext and
 * adds CDN-friendly caching headers. Documented headers are part of the storefront contract.
 */
export const Storefront = (tag: string) =>
  applyDecorators(
    Public(),
    UseGuards(StoreContextGuard),
    UseInterceptors(StorefrontCacheInterceptor),
    ApiTags(`storefront · ${tag}`),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description:
        'Store code. Optional when the request host is a store’s base URL.',
    }),
    ApiHeader({
      name: 'accept-language',
      required: false,
      description:
        'Preferred locales; matched against the store’s locales. `?locale=` wins.',
    }),
    ApiHeader({
      name: CURRENCY_HEADER,
      required: false,
      description: 'Display currency (ISO 4217) among the store’s currencies.',
    }),
    ApiBadRequestResponse({ description: 'Store could not be resolved' }),
    ApiNotFoundResponse({
      description: 'Unknown or inactive store, or resource not found',
    }),
  );

/**
 * Surrogate-key family for CDN purges: responses get `Surrogate-Key: <tag>:<id>` for every `id` in
 * the body (single resource, `data[]` lists, or arrays), plus `<tag>:list` for lists.
 */
export const CacheTag = (tag: string) => SetMetadata(CACHE_TAG_KEY, tag);

/**
 * Customer account routes (`/api/v1/store/account/*`): store scope plus a signed-in customer
 * (`Authorization: Bearer <customer access token>`); responses are never cached.
 */
export const StorefrontAccount = (tag = 'account') =>
  applyDecorators(
    Public(),
    UseGuards(StoreContextGuard, CustomerRequiredGuard),
    UseInterceptors(NoStoreInterceptor),
    ApiTags(`storefront · ${tag}`),
    ApiBearerAuth('customer'),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description:
        'Store code. Optional when the request host is a store’s base URL.',
    }),
    ApiUnauthorizedResponse({
      description: 'Not signed in, or the session ended',
    }),
  );

/**
 * Sign-up, sign-in and token refresh: store scope only; an `Authorization` header (perhaps an expired
 * access token) is ignored.
 */
export const StorefrontAuth = (tag = 'account') =>
  applyDecorators(
    Public(),
    SetMetadata(IGNORE_CUSTOMER_TOKEN, true),
    UseGuards(StoreContextGuard),
    UseInterceptors(NoStoreInterceptor),
    ApiTags(`storefront · ${tag}`),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description:
        'Store code. Optional when the request host is a store’s base URL.',
    }),
    ApiBadRequestResponse({ description: 'Store could not be resolved' }),
  );

export {
  ResponseCache,
  type ResponseCacheOptions,
} from './storefront-cache.interceptor.js';
