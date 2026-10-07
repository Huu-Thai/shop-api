import type {
  StoreSnapshot,
  StoresSnapshot,
} from '../modules/stores/stores.query.js';

/** A store as the snapshot holds it (US store, USD, tax exclusive unless overridden). */
export function storeSnap(extra: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    id: 's1',
    code: 'us',
    name: 'US',
    baseUrl: null,
    host: null,
    websiteId: 'w1',
    websiteCode: 'us',
    websiteName: 'US',
    isActive: true,
    defaultLocaleCode: 'en-US',
    localeCodes: ['en-US'],
    defaultCurrencyCode: 'USD',
    currencyCodes: ['USD'],
    countryCode: 'US',
    pricesIncludeTax: false,
    ...extra,
  };
}

/** A StoresQuery double whose snapshot holds the given stores. */
export function fakeStores(...stores: StoreSnapshot[]) {
  const list = stores.length ? stores : [storeSnap()];
  const snap: StoresSnapshot = {
    byCode: new Map(list.map((s) => [s.code, s])),
    byId: new Map(list.map((s) => [s.id, s])),
    byHost: new Map(),
    locales: new Map(
      list.flatMap((s) =>
        s.localeCodes.map((code) => [
          code,
          { code, name: code, isActive: true, fallbackCode: null },
        ]),
      ),
    ),
    fallbacks: new Map(),
    currencies: new Map([
      ['USD', { code: 'USD', minorUnits: 2, isActive: true }],
      ['VND', { code: 'VND', minorUnits: 0, isActive: true }],
    ] as never),
  };
  return { snapshot: vi.fn(async () => snap), snap };
}
