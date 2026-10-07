import { ROOT } from '../testing/principals.js';
import {
  AttributesController,
  CategoriesController,
} from './catalog/catalog.admin.controller.js';
import { MediaController } from './media/media.controller.js';
import { ProductsController } from './products/products.admin.controller.js';
import {
  ReferenceDataController,
  WebsitesStoresController,
} from './stores/stores.admin.controller.js';
import { UrlRewritesController } from './url-rewrites/url-rewrites.admin.controller.js';

/** A service double whose every method records its call and returns a marker. */
function service() {
  const calls: Record<string, unknown[][]> = {};
  const proxy = new Proxy({} as Record<string, (...a: unknown[]) => unknown>, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return name === 'enqueueStoreRebuild'
          ? Promise.resolve(['s1'])
          : `ok:${name}`;
      },
  });
  return { proxy, calls };
}

type Case = [
  method: string,
  args: unknown[],
  serviceMethod: string,
  expectedArgs?: unknown[],
];

const run = async (
  controller: Record<string, (...a: unknown[]) => unknown>,
  svcs: ReturnType<typeof service>[],
  cases: Case[],
) => {
  for (const [method, args, serviceMethod, expectedArgs] of cases) {
    await controller[method](...args);
    const svc = svcs.find((s) => s.calls[serviceMethod]);
    expect(svc, `${method} → ${serviceMethod}`).toBeDefined();
    if (expectedArgs)
      expect(svc!.calls[serviceMethod].at(-1)).toEqual(expectedArgs);
  }
};

describe('admin controllers delegate to their services', () => {
  it('locales, currencies, websites and stores', async () => {
    const ref = service();
    await run(
      new ReferenceDataController(ref.proxy as never) as never,
      [ref],
      [
        ['locales', [true], 'locales', [true]],
        ['createLocale', [{}, ROOT], 'createLocale'],
        ['updateLocale', ['vi-VN', {}, ROOT], 'updateLocale'],
        ['currencies', [undefined], 'currencies'],
        ['createCurrency', [{}, ROOT], 'createCurrency'],
        [
          'updateCurrency',
          ['vnd', {}, ROOT],
          'updateCurrency',
          ['VND', {}, ROOT],
        ],
      ],
    );
    const websites = service();
    const stores = service();
    await run(
      new WebsitesStoresController(
        websites.proxy as never,
        stores.proxy as never,
      ) as never,
      [websites, stores],
      [
        ['listWebsites', [], 'list'],
        ['getWebsite', ['w'], 'get'],
        ['createWebsite', [{}, ROOT], 'create'],
        ['updateWebsite', ['w', {}, ROOT], 'update'],
        ['removeWebsite', ['w', ROOT], 'remove'],
      ],
    );
    const s2 = service();
    await run(
      new WebsitesStoresController(
        service().proxy as never,
        s2.proxy as never,
      ) as never,
      [s2],
      [
        ['listStores', ['w'], 'list', ['w']],
        ['getStore', ['s'], 'get'],
        ['createStore', [{}, ROOT], 'create'],
        ['updateStore', ['s', {}, ROOT], 'update'],
        ['removeStore', ['s', ROOT], 'remove'],
      ],
    );
  });

  it('attributes, sets and categories', async () => {
    const a = service();
    await run(
      new AttributesController(a.proxy as never) as never,
      [a],
      [
        ['list', [], 'list'],
        ['get', ['a'], 'get'],
        ['create', [{}, ROOT], 'create'],
        ['update', ['a', {}, ROOT], 'update'],
        ['remove', ['a', ROOT], 'remove'],
        ['listSets', [], 'listSets'],
        ['getSet', ['s'], 'getSet'],
        ['createSet', [{}, ROOT], 'createSet'],
        ['updateSet', ['s', {}, ROOT], 'updateSet'],
        ['removeSet', ['s', ROOT], 'removeSet'],
      ],
    );
    const c = service();
    await run(
      new CategoriesController(c.proxy as never) as never,
      [c],
      [
        ['list', [], 'list'],
        ['tree', [], 'tree'],
        ['get', ['c'], 'get'],
        ['create', [{}, ROOT], 'create'],
        ['update', ['c', {}, ROOT], 'update'],
        ['move', ['c', { parentId: null }, ROOT], 'move'],
        ['remove', ['c', ROOT], 'remove'],
      ],
    );
  });

  it('products, variants, bundles, overrides and relations', async () => {
    const products = service();
    const variants = service();
    const controller = new ProductsController(
      products.proxy as never,
      variants.proxy as never,
    ) as never;
    await run(
      controller,
      [products],
      [
        ['list', [{}], 'list'],
        ['get', ['p'], 'get'],
        ['create', [{}, ROOT], 'create'],
        ['update', ['p', {}, ROOT], 'update'],
        ['remove', ['p', ROOT], 'remove'],
        ['restore', ['p', ROOT], 'restore'],
        [
          'setOverride',
          ['p', 's', {}, ROOT],
          'setStoreOverride',
          ['p', 's', {}, ROOT],
        ],
        [
          'removeOverride',
          ['p', 's', ROOT],
          'setStoreOverride',
          ['p', 's', { status: null, visibility: null, attributes: {} }, ROOT],
        ],
        ['setRelations', ['p', {}, ROOT], 'setRelations'],
      ],
    );
    await run(
      controller,
      [variants],
      [
        ['createVariant', ['p', {}, ROOT], 'create', ['p', {}, ROOT]],
        ['updateVariant', ['p', 'v', {}, ROOT], 'update', ['p', 'v', {}, ROOT]],
        ['removeVariant', ['p', 'v', ROOT], 'remove', ['p', 'v', ROOT]],
        ['setBundleOptions', ['p', {}, ROOT], 'setBundleOptions'],
      ],
    );
  });

  it('media and URL rewrites', async () => {
    const m = service();
    const img = {
      id: 'i',
      storageKey: 'images/ab/orig.jpg',
      renditions: [
        { width: 160, height: 160, key: 'images/ab/160.webp' },
        { width: 480, height: 480, key: 'images/ab/480.webp' },
      ],
    };
    // Image reads and writes come back with URLs (signed or CDN) for each image.
    const images = new Proxy(m.proxy, {
      get:
        (t, name: string) =>
        (...args: unknown[]) => {
          t[name](...args);
          if (name === 'list')
            return { data: [img], total: 1, page: 1, limit: 25 };
          if (name === 'getMany') return [img];
          if (name === 'links' || name === 'setLinks')
            return [{ imageId: 'i', role: 'BASE', position: 0 }];
          return ['get', 'upload', 'update'].includes(name)
            ? img
            : `ok:${name}`;
        },
    });
    const media = { url: async (key: string) => `https://cdn.test/${key}` };
    const controller = new MediaController(images as never, media as never);
    await expect(controller.get('i')).resolves.toMatchObject({
      url: 'https://cdn.test/images/ab/orig.jpg',
      thumbnailUrl: 'https://cdn.test/images/ab/480.webp',
    });
    await expect(controller.categoryImages('c')).resolves.toMatchObject([
      {
        imageId: 'i',
        role: 'BASE',
        image: { url: 'https://cdn.test/images/ab/orig.jpg' },
      },
    ]);
    await expect(controller.list({} as never)).resolves.toMatchObject({
      data: [{ thumbnailUrl: 'https://cdn.test/images/ab/480.webp' }],
    });
    await run(
      controller as never,
      [m],
      [
        ['list', [{}], 'list'],
        ['get', ['i'], 'get'],
        [
          'upload',
          [undefined, { localeCode: 'en-US', alt: 'A' }, ROOT],
          'upload',
          [undefined, { localeCode: 'en-US', alt: 'A' }, ROOT],
        ],
        ['update', ['i', {}, ROOT], 'update'],
        ['remove', ['i', undefined, ROOT], 'remove', ['i', false, ROOT]],
        ['productImages', ['p'], 'links', ['PRODUCT', 'p']],
        [
          'setProductImages',
          ['p', {}, ROOT],
          'setLinks',
          ['PRODUCT', 'p', {}, ROOT],
        ],
        [
          'setVariantImages',
          ['v', {}, ROOT],
          'setLinks',
          ['VARIANT', 'v', {}, ROOT],
        ],
        [
          'setCategoryImages',
          ['c', {}, ROOT],
          'setLinks',
          ['CATEGORY', 'c', {}, ROOT],
        ],
      ],
    );
    const u = service();
    const c = new UrlRewritesController(u.proxy as never);
    await run(
      c as never,
      [u],
      [
        ['list', [{}], 'list'],
        ['create', [{}, ROOT], 'createRedirect'],
        ['remove', ['r', ROOT], 'removeRedirect'],
        ['rebuild', [{ storeId: 's1' }], 'enqueueStoreRebuild', [['s1']]],
      ],
    );
    expect(await c.rebuild({})).toEqual({ storeIds: ['s1'] });
  });
});
