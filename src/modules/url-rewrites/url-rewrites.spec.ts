import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { UrlCollisionListener } from './url-collision.listener.js';
import { UrlRewritesListener } from './url-rewrites.listener.js';
import { CatalogProcessor } from './url-rewrites.processor.js';
import { UrlRewritesQuery } from './url-rewrites.query.js';
import { UrlRewritesService } from './url-rewrites.service.js';

const ctx = {
  storeId: 's1',
  storeCode: 'us',
  websiteId: 'w1',
  websiteCode: 'us',
  localeCode: 'en-US',
  localeChain: ['en-US'],
  currencyCode: 'USD',
  countryCode: 'US',
  pricesIncludeTax: false,
};
const store = {
  id: 's1',
  websiteId: 'w1',
  defaultLocaleCode: 'en-US',
  localeCodes: ['en-US'],
};

function setup() {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  const stores = {
    snapshot: vi.fn(async () => ({
      fallbacks: new Map([['en-US', null]]),
      byId: new Map([['s1', store]]),
    })),
    storesOfWebsites: vi.fn(async (ids: string[]) =>
      ids.includes('w1') ? [store] : [],
    ),
    store: vi.fn(async (id: string) => (id === 's1' ? store : undefined)),
  };
  const products = {
    urlData: vi.fn(),
    idsOnWebsite: vi.fn(async () => ['p1']),
  };
  const categories = { withAncestors: vi.fn(async () => new Map()) };
  const queue = {
    add: vi.fn(async (_n: string, _d: object, _o: object) => undefined),
  };
  let generation = 0;
  const redis = {
    incr: vi.fn(async () => ++generation),
    get: vi.fn(async () => String(generation)),
  };
  const svc = new UrlRewritesService(
    prisma as never,
    fb.bus,
    stores as never,
    products as never,
    categories as never,
    queue as never,
    redis as never,
  );
  return { svc, prisma, stores, products, categories, queue, redis, ...fb };
}

describe('UrlRewritesService', () => {
  it('rebuilds a product: canonical URL per store locale, projection event', async () => {
    const { svc, prisma, products, after } = setup();
    products.urlData.mockResolvedValue({
      id: 'p1',
      deletedAt: null,
      websites: [{ websiteId: 'w1' }],
      translations: [{ localeCode: 'en-US', slug: 'tee' }],
    });
    await svc.rebuildProduct('p1');
    expect(prisma.urlRewrite.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: 's1',
          localeCode: 'en-US',
          requestPath: 'tee',
          redirectType: null,
          targetType: 'PRODUCT',
          targetId: 'p1',
          isSystem: true,
        },
      ],
    });
    expect(after[0]).toMatchObject({
      name: 'url-rewrites.rebuilt',
      data: { targetType: 'PRODUCT', created: 1 },
    });
  });

  it('a renamed product keeps its old URL as a 301; a deleted one loses all URLs', async () => {
    const { svc, prisma, products } = setup();
    products.urlData.mockResolvedValue({
      id: 'p1',
      deletedAt: null,
      websites: [{ websiteId: 'w1' }],
      translations: [{ localeCode: 'en-US', slug: 'new' }],
    });
    prisma.urlRewrite.findMany.mockResolvedValueOnce([
      {
        id: 'old',
        storeId: 's1',
        localeCode: 'en-US',
        requestPath: 'tee',
        targetType: 'PRODUCT',
        targetId: 'p1',
        redirectType: null,
        isSystem: true,
      },
    ]);
    await svc.rebuildProduct('p1');
    expect(prisma.urlRewrite.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: { redirectType: 301 },
    });
    products.urlData.mockResolvedValue({
      id: 'p1',
      deletedAt: new Date(),
      websites: [],
      translations: [],
    });
    prisma.urlRewrite.findMany.mockResolvedValueOnce([
      {
        id: 'a',
        storeId: 's1',
        localeCode: 'en-US',
        requestPath: 'new',
        targetType: 'PRODUCT',
        targetId: 'p1',
        redirectType: null,
        isSystem: true,
      },
    ]);
    await svc.rebuildProduct('p1');
    expect(prisma.urlRewrite.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
    });
  });

  it('logs collisions and leaves other pages alone', async () => {
    const { svc, prisma, products, after } = setup();
    products.urlData.mockResolvedValue({
      id: 'p1',
      deletedAt: null,
      websites: [{ websiteId: 'w1' }],
      translations: [{ localeCode: 'en-US', slug: 'men' }],
    });
    prisma.urlRewrite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'c',
        storeId: 's1',
        localeCode: 'en-US',
        requestPath: 'men',
        targetType: 'CATEGORY',
        targetId: 'c1',
        redirectType: null,
        isSystem: true,
      },
    ]);
    await svc.rebuildProduct('p1');
    expect(prisma.urlRewrite.createMany).not.toHaveBeenCalled();
    expect(after[0]).toMatchObject({ data: { collisions: 1 } });
  });

  it('rebuilds categories from their ancestry; missing ancestors or nodes produce no URL', async () => {
    const { svc, prisma, categories } = setup();
    const node = (id: string, path: string, slug: string) => ({
      id,
      path,
      websiteIds: ['w1'],
      translations: [{ localeCode: 'en-US', slug }],
    });
    categories.withAncestors.mockResolvedValue(
      new Map([
        ['men', node('men', 'men', 'men')],
        ['tees', node('tees', 'men/tees', 't-shirts')],
        ['lost', node('lost', 'gone/lost', 'x')],
      ]),
    );
    await svc.rebuildCategories(['tees', 'lost', 'deleted']);
    expect(prisma.urlRewrite.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.urlRewrite.createMany.mock.calls[0][0].data[0]).toMatchObject(
      { requestPath: 'men/t-shirts', targetType: 'CATEGORY', targetId: 'tees' },
    );
  });

  it('rebuilds a whole store and drops rows of targets that left it; a deleted store loses everything', async () => {
    const { svc, prisma, products } = setup();
    products.urlData.mockResolvedValue(null);
    prisma.categoryWebsite.findMany.mockResolvedValue([{ categoryId: 'c1' }]);
    expect(await svc.rebuildStore('s1')).toEqual({
      products: 1,
      categories: 1,
    });
    expect(
      prisma.urlRewrite.deleteMany.mock.calls.at(-1)![0].where,
    ).toMatchObject({ storeId: 's1', isSystem: true });
    expect(await svc.rebuildStore('gone')).toEqual({
      products: 0,
      categories: 0,
    });
  });

  it('queues store rebuilds', async () => {
    const { svc, queue } = setup();
    expect(await svc.enqueueStoreRebuild()).toEqual(['s1']);
    expect(await svc.enqueueStoreRebuild(['s2'])).toEqual(['s2']);
    expect(queue.add).toHaveBeenCalledWith(
      'url-rewrites-rebuild-store',
      { storeId: 's2', generation: 2 },
      expect.objectContaining({ attempts: 3, delay: 1000 }),
    );
  });

  it('custom redirects: normalised path, system rows protected', async () => {
    const { svc, prisma, afterNames } = setup();
    await expect(
      svc.createRedirect(
        {
          storeId: 's1',
          localeCode: 'en-US',
          requestPath: '/',
          targetPath: '/x',
        },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.urlRewrite.create.mockImplementation(
      async ({ data }: { data: object }) => ({ id: 'r', ...data }),
    );
    const r = await svc.createRedirect(
      {
        storeId: 's1',
        localeCode: 'en-US',
        requestPath: '/Summer-Sale/',
        targetPath: ' /women ',
      },
      ROOT,
    );
    expect(r).toMatchObject({
      requestPath: 'summer-sale',
      targetPath: '/women',
      redirectType: 301,
      isSystem: false,
      targetType: 'CUSTOM',
    });
    prisma.urlRewrite.findUnique.mockResolvedValue({
      isSystem: true,
      requestPath: 'tee',
    });
    await expect(svc.removeRedirect('r', ROOT)).rejects.toThrow(
      'change the slug',
    );
    prisma.urlRewrite.findUnique.mockResolvedValue({
      isSystem: false,
      requestPath: 'summer-sale',
    });
    await svc.removeRedirect('r', ROOT);
    prisma.urlRewrite.findUnique.mockResolvedValue(null);
    await expect(svc.removeRedirect('r', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(afterNames()).toEqual([
      'url-rewrite.created',
      'url-rewrite.deleted',
    ]);
    prisma.urlRewrite.count.mockResolvedValue(0);
    expect(
      await svc.list({
        page: 1,
        limit: 10,
        skip: 0,
        order: 'desc',
        search: '/Sale',
      } as never),
    ).toMatchObject({ total: 0 });
    expect(
      prisma.urlRewrite.findMany.mock.calls.at(-1)![0].where.requestPath,
    ).toEqual({ contains: 'sale' });
  });
});

describe('UrlRewritesQuery', () => {
  it('resolves canonical URLs, redirects and custom redirects', async () => {
    const prisma = fakePrisma();
    const q = new UrlRewritesQuery(prisma as never);
    expect(await q.resolve(ctx, '/nothing')).toBeUndefined();
    prisma.urlRewrite.findUnique.mockResolvedValueOnce({
      targetType: 'PRODUCT',
      targetId: 'p1',
      targetPath: null,
      redirectType: null,
    });
    expect(await q.resolve(ctx, '/Tee/')).toEqual({
      type: 'PRODUCT',
      id: 'p1',
      canonicalPath: 'tee',
      redirectStatus: null,
      location: null,
    });
    prisma.urlRewrite.findUnique.mockResolvedValueOnce({
      targetType: 'PRODUCT',
      targetId: 'p1',
      targetPath: null,
      redirectType: 301,
    });
    prisma.urlRewrite.findMany.mockResolvedValueOnce([
      { targetId: 'p1', requestPath: 'new-tee' },
    ]);
    expect(await q.resolve(ctx, '/tee')).toEqual({
      type: 'PRODUCT',
      id: 'p1',
      canonicalPath: 'new-tee',
      redirectStatus: 301,
      location: '/new-tee',
    });
    prisma.urlRewrite.findUnique.mockResolvedValueOnce({
      targetType: 'PRODUCT',
      targetId: 'p1',
      targetPath: null,
      redirectType: 301,
    });
    expect(await q.resolve(ctx, '/tee')).toBeUndefined(); // dead end
    prisma.urlRewrite.findUnique.mockResolvedValueOnce({
      targetType: 'CUSTOM',
      targetId: null,
      targetPath: '/sale',
      redirectType: 302,
    });
    expect(await q.resolve(ctx, '/promo')).toEqual({
      type: 'CUSTOM',
      id: null,
      canonicalPath: null,
      redirectStatus: 302,
      location: '/sale',
    });
    expect(await q.canonicalPaths(ctx, 'PRODUCT', [])).toEqual(new Map());
  });
});

describe('UrlRewritesListener', () => {
  it('rebuilds only when URLs can have changed', async () => {
    const rewrites = {
      rebuildProduct: vi.fn(),
      rebuildCategories: vi.fn(),
      enqueueStoreRebuild: vi.fn(),
    };
    const categories = { subtreeIds: vi.fn(async () => ['c1', 'c2']) };
    const l = new UrlRewritesListener(rewrites as never, categories as never);
    const p = (urlsChanged: boolean) =>
      ({ data: { productId: 'p1', urlsChanged } }) as never;
    await l.onProductCreated(p(true));
    await l.onProductUpdated(p(false));
    await l.onProductDeleted(p(true));
    await l.onProductRestored(p(true));
    expect(rewrites.rebuildProduct).toHaveBeenCalledTimes(3);
    const c = (urlsChanged: boolean) =>
      ({ data: { categoryId: 'c1', path: 'c1', urlsChanged } }) as never;
    await l.onCategoryCreated(c(true));
    await l.onCategoryUpdated(c(false));
    await l.onCategoryMoved(c(true));
    await l.onCategoryDeleted(c(true));
    expect(rewrites.rebuildCategories.mock.calls).toEqual([
      [['c1', 'c2']],
      [['c1', 'c2']],
      [['c1']],
    ]);
    await l.onStoreCreated({
      data: { storeId: 's1', localesChanged: true },
    } as never);
    await l.onStoreUpdated({
      data: { storeId: 's1', localesChanged: false },
    } as never);
    expect(rewrites.enqueueStoreRebuild).toHaveBeenCalledTimes(1);
  });
});

describe('UrlCollisionListener', () => {
  it('vetoes product slugs that are another page’s URL', async () => {
    const prisma = fakePrisma();
    const l = new UrlCollisionListener(
      prisma as never,
      new UrlRewritesQuery(prisma as never),
    );
    await l.onProductWrite({ entityId: null, input: { slugs: [] } } as never);
    prisma.urlRewrite.findMany.mockResolvedValue([
      { requestPath: 'men', localeCode: 'en-US', targetType: 'CATEGORY' },
    ]);
    await expect(
      l.onProductWrite({
        entityId: 'p1',
        input: { slugs: [{ localeCode: 'en-US', slug: 'men' }] },
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      prisma.urlRewrite.findMany.mock.calls[0][0].where.AND,
    ).toContainEqual({
      NOT: { targetType: 'PRODUCT', targetId: 'p1' },
    });
  });

  it('derives a child category’s future path from its parent', async () => {
    const prisma = fakePrisma();
    const l = new UrlCollisionListener(
      prisma as never,
      new UrlRewritesQuery(prisma as never),
    );
    await l.onCategoryWrite({
      entityId: 'c',
      input: { parentId: null, slugs: [] },
    } as never);
    prisma.urlRewrite.findMany
      .mockResolvedValueOnce([{ localeCode: 'en-US', requestPath: 'men' }])
      .mockResolvedValueOnce([]);
    await l.onCategoryWrite({
      entityId: null,
      input: {
        parentId: 'men',
        slugs: [
          { localeCode: 'en-US', slug: 'tees' },
          { localeCode: 'vi-VN', slug: 'ao' },
        ],
      },
    } as never);
    expect(prisma.urlRewrite.findMany.mock.calls[1][0].where.OR).toEqual([
      { localeCode: 'en-US', requestPath: 'men/tees' },
    ]);
    prisma.urlRewrite.findMany.mockResolvedValueOnce([
      { requestPath: 'tees', localeCode: 'en-US', targetType: 'PRODUCT' },
    ]);
    await expect(
      l.onCategoryWrite({
        entityId: null,
        input: {
          parentId: null,
          slugs: [{ localeCode: 'en-US', slug: 'tees' }],
        },
      } as never),
    ).rejects.toMatchObject({
      response: {
        message: [expect.stringContaining('already belongs to a product')],
      },
    });
  });
});

describe('CatalogProcessor', () => {
  it('runs store rebuilds', async () => {
    const rewrites = {
      rebuildStore: vi.fn(async () => ({ products: 1, categories: 0 })),
    };
    const redis = { get: vi.fn(async () => '2') };
    const p = new CatalogProcessor(rewrites as never, redis as never);
    expect(
      await p.process({
        id: '1',
        name: 'url-rewrites-rebuild-store',
        data: { storeId: 's1' },
      } as never),
    ).toEqual({ products: 1, categories: 0 });
    expect(await p.process({ id: '2', name: 'x', data: {} } as never)).toEqual({
      skipped: 'unknown job x',
    });
  });
});
