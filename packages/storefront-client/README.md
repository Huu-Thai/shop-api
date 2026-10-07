# @shop/storefront-client

A typed client for the Shop storefront API. It is generated from the reviewed contract in [`openapi/storefront.json`](../../openapi/storefront.json).

```ts
import { createStorefrontClient, type Product } from '@shop/storefront-client';

const shop = createStorefrontClient({
  baseUrl: 'https://api.shop.example',
  store: 'vn-vi',
  locale: 'vi-VN',
});

const { data: tree } = await shop.GET('/api/v1/store/categories');
const { data: list } = await shop.GET(
  '/api/v1/store/categories/{id}/products',
  {
    params: { path: { id }, query: { filter: ['color:red'], sort: 'name' } },
  },
);
const { data: product, error } = await shop.GET(
  '/api/v1/store/products/by-slug/{slug}',
  { params: { path: { slug } } },
);
```

Search and faceted browsing (counts stay correct for multi-select facets):

```ts
const { data: results } = await shop.GET('/api/v1/store/search', {
  params: {
    query: {
      q: 'tee',
      filter: ['color:red,blue'],
      inStock: true,
      sort: 'price_asc',
    },
  },
});
const { data: suggestions } = await shop.GET('/api/v1/store/search/suggest', {
  params: { query: { q: 'te' } },
});
```

Customer accounts: sign in, keep the tokens, and pass the access token on every request (catalog prices then follow the customer's group; those responses are `private, no-store`):

```ts
let tokens: TokenPair | undefined;
const shop = createStorefrontClient({
  baseUrl,
  store: 'us-en',
  accessToken: () => tokens?.accessToken,
});
const { data } = await shop.POST('/api/v1/store/account/login', {
  body: { email, password },
});
tokens = data;
const { data: me } = await shop.GET('/api/v1/store/account');
const { data: points } = await shop.GET('/api/v1/store/account/loyalty');
// On 401, exchange the refresh token once (it is single-use): POST /api/v1/store/account/refresh.
```

Checkout: a guest keeps the cart token (customers use their session), places the order once per `Idempotency-Key`, and keeps the order token to read and pay it:

```ts
let cartToken: string | undefined;
const shop = createStorefrontClient({
  baseUrl,
  store: 'us-en',
  cartToken: () => cartToken,
});
const { data: cart } = await shop.POST('/api/v1/store/cart');
cartToken = cart?.token;
await shop.POST('/api/v1/store/cart/items', {
  body: { sku: 'TEE-CLASSIC-BLACK-M', quantity: 2 },
});
await shop.PUT('/api/v1/store/cart/email', { body: { email } });
await shop.PUT('/api/v1/store/cart/addresses', { body: { shipping: address } });
await shop.PUT('/api/v1/store/cart/shipping-method', {
  body: { code: 'standard' },
});
const { data: ready } = await shop.GET('/api/v1/store/cart'); // ready.missing is empty when it can be ordered
const { data: order } = await shop.POST('/api/v1/store/orders', {
  params: { header: { 'idempotency-key': crypto.randomUUID() } }, // reuse the same key when retrying
});
const orderToken = { 'x-order-token': order!.accessToken! }; // guests only
const { data: payment } = await shop.POST(
  '/api/v1/store/orders/{number}/payments',
  {
    params: { path: { number: order!.number }, header: orderToken },
    body: { method: 'card', returnUrl: `${location.origin}/checkout/return` },
  },
);
// payment.action: REDIRECT → go to action.url; CLIENT_SECRET → confirm with Stripe.js; NONE → done.
// Back from a redirect: POST /api/v1/store/orders/{number}/payments/{id}/return with the query parameters.
```

Content: `pages/by-path`, `posts`, `blocks/{identifier}`, `menus/{code}`, `banners?placement=…` and `sliders/{code}` return CMS content with blocks already rendered.

Use `GET /api/v1/store/url-resolver?path=/…` to map any storefront path to a product, category, page, post or redirect. Follow `redirectStatus` and `location` when they are set.

**Updating the client:** when the storefront API changes on purpose, run `npm run contract:update` in the repository root. It regenerates `openapi/storefront.json` and `src/schema.ts`; review both diffs. Within `v1`, changes are additive only.
