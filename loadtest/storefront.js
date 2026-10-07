// k6 load test of the storefront SLOs (docs/RUNBOOK.md#slos). Runs against a seeded stack:
//   docker run --rm -i --network host -e BASE_URL=http://127.0.0.1:3398 grafana/k6 run - < loadtest/storefront.js
// Scenarios: catalog browsing and search (constant arrival rate) plus guest checkouts with cash on
// delivery. Thresholds are the SLOs; k6 exits non-zero when one is missed.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:3398') + '/api/v1';
const STORE = __ENV.STORE || 'us-en';
const BROWSE_RPS = Number(__ENV.BROWSE_RPS || 60);
const CHECKOUTS_PER_S = Number(__ENV.CHECKOUTS_PER_S || 2);
const DURATION = __ENV.DURATION || '3m';
// In production return URLs must be https (and on the storefront's domain when one is configured).
const RETURN_URL = __ENV.RETURN_URL || 'https://shop.example/checkout/done';

const placeOrder = new Trend('place_order_duration', true);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      exec: 'browse',
      rate: BROWSE_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 40,
      maxVUs: 200,
    },
    checkout: {
      executor: 'constant-arrival-rate',
      exec: 'checkout',
      rate: CHECKOUTS_PER_S,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{kind:read}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{kind:search}': ['p(95)<400'],
    'http_req_duration{kind:cart}': ['p(95)<1000'],
    place_order_duration: ['p(95)<1500'],
  },
};

const headers = (extra = {}) => ({
  'content-type': 'application/json',
  'x-store': STORE,
  ...extra,
});
const get = (path, kind, extra) =>
  http.get(`${BASE}${path}`, { headers: headers(extra), tags: { kind, name: path.replace(/[0-9a-f-]{36}/g, ':id').split('?')[0] } });
const send = (method, path, body, extra, kind = 'cart') =>
  http.request(method, `${BASE}${path}`, JSON.stringify(body ?? {}), {
    headers: headers(extra),
    tags: { kind, name: path.replace(/[0-9a-f-]{36}/g, ':id').replace(/US-\d+/, ':number') },
  });

export function setup() {
  const tree = get('/store/categories', 'read');
  if (tree.status !== 200) fail(`categories: ${tree.status} ${tree.body}`);
  const categoryIds = [];
  const walk = (nodes) => nodes.forEach((n) => { categoryIds.push(n.id); walk(n.children || []); });
  walk(tree.json());
  const slugs = new Set();
  const paths = new Set();
  for (const id of categoryIds) {
    const list = get(`/store/categories/${id}/products?limit=50`, 'read');
    for (const p of list.json('data') || []) {
      if (p.slug) slugs.add(p.slug);
      if (p.urlPath) paths.add(p.urlPath);
    }
  }
  if (!slugs.size) fail('No products: seed the demo catalog first (npm run seed:demo)');
  return {
    categoryIds,
    slugs: [...slugs],
    paths: [...paths],
    terms: ['tee', 'socks', 'classic', 'weekend', 'gift'],
  };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** One storefront read, weighted like real traffic (product pages and listings dominate). */
export function browse(data) {
  const r = Math.random();
  let res;
  if (r < 0.35) res = get(`/store/products/by-slug/${pick(data.slugs)}`, 'read');
  else if (r < 0.6) res = get(`/store/categories/${pick(data.categoryIds)}/products?limit=24`, 'read');
  else if (r < 0.75) res = get(`/store/search?q=${pick(data.terms)}`, 'search');
  else if (r < 0.85) res = get(`/store/search/suggest?q=${pick(data.terms).slice(0, 3)}`, 'search');
  else if (r < 0.95) res = get('/store/config', 'read');
  else res = get(`/store/url-resolver?path=${encodeURIComponent(pick(data.paths))}`, 'read');
  check(res, { 'read 200': (x) => x.status === 200 });
}

/** A guest checkout: cart, items, e-mail, address, shipping, order, cash on delivery. */
export function checkout() {
  const cart = send('POST', '/store/cart');
  if (!check(cart, { 'cart created': (x) => x.status === 200 })) return;
  const t = { 'x-cart-token': cart.json('token') };
  const steps = [
    send('POST', '/store/cart/items', { sku: 'TEE-CLASSIC-BLACK-M', quantity: 1 }, t),
    send('POST', '/store/cart/items', { sku: 'SOCKS-3PK', quantity: 2 }, t),
    send('PUT', '/store/cart/email', { email: `load-${__VU}-${__ITER}@example.com` }, t),
    send('PUT', '/store/cart/addresses', {
      shipping: { firstName: 'Load', lastName: 'Test', countryCode: 'US', regionCode: 'CA', city: 'Los Angeles', postcode: '90001', line1: '1 Main St' },
    }, t),
    send('PUT', '/store/cart/shipping-method', { code: 'standard' }, t),
  ];
  if (!check(steps, { 'cart steps 200': (s) => s.every((x) => x.status === 200) })) {
    const bad = steps.find((x) => x.status !== 200);
    console.warn(`cart step failed: ${bad.status} ${bad.body}`);
    return;
  }
  const key = `load-${__VU}-${__ITER}-${Date.now()}`;
  const order = send('POST', '/store/orders', null, { ...t, 'idempotency-key': key }, 'order');
  placeOrder.add(order.timings.duration);
  if (!check(order, { 'order placed': (x) => x.status === 200 })) {
    console.warn(`order failed: ${order.status} ${order.body}`);
    return;
  }
  const pay = send('POST', `/store/orders/${order.json('number')}/payments`,
    { method: 'cod', returnUrl: RETURN_URL },
    { 'x-order-token': order.json('accessToken') }, 'order');
  if (!check(pay, { 'cash on delivery accepted': (x) => x.status === 200 && x.json('status') === 'AWAITING_COLLECTION' }))
    console.warn(`payment failed: ${pay.status} ${pay.body}`);
}
