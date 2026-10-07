import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The storefront scope of one request (PLAN.md §3.3). Every storefront read takes this object, so
 * there is no way to query the catalog without a website/store/locale — a forgotten filter can't
 * leak another store's data.
 */
export interface StoreContext {
  storeId: string;
  storeCode: string;
  websiteId: string;
  websiteCode: string;
  /** The negotiated locale. */
  localeCode: string;
  /** Translation fallback: locale → its fallbacks → the store default. */
  localeChain: string[];
  currencyCode: string;
  countryCode: string;
  pricesIncludeTax: boolean;
  /** The signed-in customer (customer access token), if any; prices use their group. */
  customer?: StorefrontCustomer;
}

/** A signed-in shopper, resolved from a customer access token. */
export interface StorefrontCustomer {
  id: string;
  websiteId: string;
  email: string;
  groupId: string;
  groupCode: string;
  /** Refresh-token family of the session (logout ends it). */
  sessionId: string;
}

/**
 * Turns a customer access token into a StorefrontCustomer (provided by the customers module, so the
 * store scope doesn't depend on it). Throws 401 for invalid, expired or revoked tokens.
 */
export interface CustomerTokenResolver {
  resolve(token: string): Promise<StorefrontCustomer>;
}
export const CUSTOMER_TOKEN_RESOLVER = Symbol('CUSTOMER_TOKEN_RESOLVER');

export type StorefrontRequest = Request & { storeContext?: StoreContext };

export const StoreCtx = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StoreContext => {
    const store = ctx
      .switchToHttp()
      .getRequest<StorefrontRequest>().storeContext;
    if (!store)
      throw new Error('StoreCtx used on a route without @Storefront()');
    return store;
  },
);

/** The signed-in customer of an account route (see `@StorefrontAccount()`). */
export const CurrentCustomer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StorefrontCustomer => {
    const customer = ctx.switchToHttp().getRequest<StorefrontRequest>()
      .storeContext?.customer;
    if (!customer)
      throw new Error(
        'CurrentCustomer used on a route without @StorefrontAccount()',
      );
    return customer;
  },
);
