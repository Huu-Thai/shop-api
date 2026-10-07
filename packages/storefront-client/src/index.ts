/**
 * @shop/storefront-client — typed access to the Shop storefront API.
 *
 *   const shop = createStorefrontClient({ baseUrl: 'https://api.example.com', store: 'vn-vi', locale: 'vi-VN' });
 *   const { data, error } = await shop.GET('/api/v1/store/products/by-slug/{slug}', { params: { path: { slug } } });
 *
 * Types come from `schema.ts`, generated from the reviewed contract (`openapi/storefront.json`).
 */
import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { components, operations, paths } from './schema.js';

export type { components, operations, paths };

type Schemas = components['schemas'];
export type StoreConfig = Schemas['StorefrontConfigDto'];
export type Category = Schemas['StorefrontCategoryDto'];
export type CategoryNode = Schemas['StorefrontCategoryNodeDto'];
export type ProductCard = Schemas['StorefrontProductCardDto'];
export type ProductList = Schemas['StorefrontProductListDto'];
export type Product = Schemas['StorefrontProductDto'];
export type ProductVariant = Schemas['StorefrontVariantDto'];
export type Image = Schemas['StorefrontImageDto'];
export type UrlResolution = Schemas['StorefrontUrlResolutionDto'];
export type Price = Schemas['StorefrontPriceDto'];
export type SearchResult = Schemas['StorefrontSearchResultDto'];
export type Facet = Schemas['StorefrontFacetDto'];
export type Suggestion = Schemas['StorefrontSuggestionDto'];
export type Page = Schemas['StorefrontPageDto'];
export type PostCard = Schemas['StorefrontPostCardDto'];
export type Post = Schemas['StorefrontPostDto'];
export type PostList = Schemas['StorefrontPostListDto'];
export type Block = Schemas['StorefrontBlockDto'];
export type Region = Schemas['StorefrontRegionDto'];
export type Menu = Schemas['StorefrontMenuDto'];
export type MenuItem = Schemas['StorefrontMenuItemDto'];
export type Banner = Schemas['StorefrontBannerDto'];
export type Slider = Schemas['StorefrontSliderDto'];
export type Media = Schemas['StorefrontMediaDto'];
export type TokenPair = Schemas['CustomerTokenPairDto'];
export type Profile = Schemas['ProfileDto'];
export type Address = Schemas['AddressDto'];
export type Loyalty = Schemas['StorefrontLoyaltyDto'];
export type Money = Schemas['MoneyDto'];
export type Cart = Schemas['CartDto'];
export type CartLine = Schemas['CartLineViewDto'];
export type CartTotals = Schemas['CartTotalsDto'];
export type ShippingOption = Schemas['ShippingOptionDto'];
export type PaymentMethod = Schemas['PaymentMethodDto'];
export type Payment = Schemas['PaymentDto'];
export type PaymentAction = Schemas['PaymentActionDto'];
export type Order = Schemas['OrderDto'];
export type OrderSummary = Schemas['OrderSummaryDto'];
export type OrderList = Schemas['OrderListDto'];

export interface StorefrontClientOptions extends Omit<
  ClientOptions,
  'baseUrl'
> {
  /** API origin, e.g. https://api.shop.example (without /api/v1). */
  baseUrl: string;
  /** Store code (X-Store). Optional when the API is called on a store's own domain. */
  store?: string;
  /** Preferred locale (Accept-Language), e.g. vi-VN. */
  locale?: string;
  /** Display currency (X-Currency), e.g. VND. */
  currency?: string;
  /**
   * The signed-in customer's access token (from `account/login` or `account/refresh`), read on
   * every request. Catalog responses then carry the customer's group prices.
   */
  accessToken?: () => string | undefined;
  /** A guest's cart token (from `POST /store/cart`), sent as X-Cart-Token; signed-in customers don't need it. */
  cartToken?: () => string | undefined;
}

export type StorefrontClient = Client<paths>;

/** An openapi-fetch client with the store scope headers applied to every request. */
export function createStorefrontClient({
  baseUrl,
  store,
  locale,
  currency,
  headers,
  accessToken,
  cartToken,
  ...rest
}: StorefrontClientOptions): StorefrontClient {
  const client = createClient<paths>({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    headers: {
      ...(store ? { 'x-store': store } : {}),
      ...(locale ? { 'accept-language': locale } : {}),
      ...(currency ? { 'x-currency': currency } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    ...rest,
  });
  if (accessToken || cartToken)
    client.use({
      onRequest({ request }) {
        const token = accessToken?.();
        if (token) request.headers.set('authorization', `Bearer ${token}`);
        const cart = cartToken?.();
        if (cart && !request.headers.has('x-cart-token'))
          request.headers.set('x-cart-token', cart);
        return request;
      },
    });
  return client;
}
