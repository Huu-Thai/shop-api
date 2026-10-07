import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  localeChain,
  negotiateLocale,
} from '../../../common/i18n/locale-chain.js';
import {
  type StoreSnapshot,
  StoresQuery,
  type StoresSnapshot,
} from '../stores.query.js';
import {
  CUSTOMER_TOKEN_RESOLVER,
  type CustomerTokenResolver,
  type StoreContext,
  type StorefrontRequest,
} from './store-context.js';

export const STORE_HEADER = 'x-store';
export const CURRENCY_HEADER = 'x-currency';

/**
 * Resolves the storefront scope: store from `X-Store` (code) or the request host (`stores.base_url`),
 * locale from `?locale=` or `Accept-Language` among the store's locales, currency from `X-Currency`
 * among its currencies (unknown values fall back to the store defaults, so caches stay small).
 */
/** Routes that must not resolve a customer token (sign-in, sign-up, refresh). */
export const IGNORE_CUSTOMER_TOKEN = 'storefront:ignoreCustomerToken';

@Injectable()
export class StoreContextGuard implements CanActivate {
  constructor(
    private readonly stores: StoresQuery,
    private readonly reflector: Reflector,
    @Optional()
    @Inject(CUSTOMER_TOKEN_RESOLVER)
    private readonly customers?: CustomerTokenResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StorefrontRequest>();
    const context = resolveStoreContext(await this.stores.snapshot(), {
      storeCode: header(req, STORE_HEADER),
      host: (req.headers.host ?? '').toLowerCase(),
      locale:
        typeof req.query?.locale === 'string' ? req.query.locale : undefined,
      acceptLanguage: header(req, 'accept-language'),
      currency: header(req, CURRENCY_HEADER),
    });
    // A customer access token is optional on the storefront; when sent it must be valid (so the
    // frontend knows to refresh) and belong to this store's website.
    const bearer = /^Bearer\s+(\S+)$/i.exec(
      req.headers.authorization ?? '',
    )?.[1];
    const ignore = this.reflector.getAllAndOverride<boolean>(
      IGNORE_CUSTOMER_TOKEN,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (bearer && this.customers && !ignore) {
      const customer = await this.customers.resolve(bearer);
      if (customer.websiteId !== context.websiteId)
        throw new UnauthorizedException(
          'This session belongs to another website; sign in again',
        );
      context.customer = customer;
    }
    req.storeContext = context;
    return true;
  }
}

/** Account routes: a signed-in customer is required (run after StoreContextGuard). */
@Injectable()
export class CustomerRequiredGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<StorefrontRequest>();
    if (!req.storeContext?.customer)
      throw new UnauthorizedException('Sign in to continue');
    return true;
  }
}

function header(req: StorefrontRequest, name: string): string | undefined {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

export interface StoreRequestInput {
  storeCode?: string;
  host?: string;
  locale?: string;
  acceptLanguage?: string;
  currency?: string;
  /** Background work (search indexing) builds contexts for inactive stores/locales too. */
  ignoreInactive?: boolean;
}

export function resolveStoreContext(
  snap: StoresSnapshot,
  input: StoreRequestInput,
): StoreContext {
  const store = pickStore(snap, input);
  const activeLocales = input.ignoreInactive
    ? store.localeCodes
    : store.localeCodes.filter((c) => snap.locales.get(c)?.isActive);
  const locales = activeLocales.length
    ? activeLocales
    : [store.defaultLocaleCode];
  const localeCode =
    (input.locale &&
      locales.find((l) => l.toLowerCase() === input.locale!.toLowerCase())) ||
    negotiateLocale(input.acceptLanguage, locales) ||
    (locales.includes(store.defaultLocaleCode)
      ? store.defaultLocaleCode
      : locales[0]);
  const wanted = input.currency?.toUpperCase();
  const currencyCode =
    wanted &&
    store.currencyCodes.includes(wanted) &&
    snap.currencies.get(wanted)?.isActive
      ? wanted
      : store.defaultCurrencyCode;
  return {
    storeId: store.id,
    storeCode: store.code,
    websiteId: store.websiteId,
    websiteCode: store.websiteCode,
    localeCode,
    localeChain: localeChain(
      localeCode,
      snap.fallbacks,
      store.defaultLocaleCode,
    ),
    currencyCode,
    countryCode: store.countryCode,
    pricesIncludeTax: store.pricesIncludeTax,
  };
}

function pickStore(
  snap: StoresSnapshot,
  input: StoreRequestInput,
): StoreSnapshot {
  let store: StoreSnapshot | undefined;
  if (input.storeCode) {
    store = snap.byCode.get(input.storeCode.toLowerCase());
    if (!store)
      throw new NotFoundException(`Unknown store "${input.storeCode}"`);
  } else {
    const candidates = (input.host && snap.byHost.get(input.host)) || [];
    const active = candidates.filter((s) => s.isActive);
    if (active.length > 1)
      throw new BadRequestException(
        `Several stores use ${input.host}; send the ${STORE_HEADER} header`,
      );
    store = active[0] ?? candidates[0];
    if (!store)
      throw new BadRequestException(
        `Send the ${STORE_HEADER} header (store code) or call a store's own domain`,
      );
  }
  if (!store.isActive && !input.ignoreInactive)
    throw new NotFoundException(`Store "${store.code}" is not available`);
  return store;
}
