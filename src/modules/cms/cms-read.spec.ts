import { ConflictException } from '@nestjs/common';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import type { StoreContext } from '../stores/context/store-context.js';
import {
  BlocksController,
  PagesController,
  PostsController,
  TagsController,
} from './cms.admin.controller.js';
import { CmsListener } from './cms.listener.js';
import { CmsQuery } from './cms.query.js';
import {
  StorefrontBlocksController,
  StorefrontPagesController,
  StorefrontPostsController,
} from './cms.storefront.controller.js';
import { CmsUrlCollisionListener } from './cms-url-collision.listener.js';
import { CmsUrlsService } from './cms-urls.service.js';

const ctx = {
  storeId: 's1',
  storeCode: 'en',
  websiteId: 'w',
  localeCode: 'en-US',
  localeChain: ['en-US'],
} as StoreContext;

const en = (fields: object) => [{ localeCode: 'en-US', ...fields }];

describe('CmsQuery', () => {
  function setup() {
    const prisma = fakePrisma();
    const urls = {
      canonicalPaths: vi.fn(
        async (_c: unknown, _t: string, ids: string[]) =>
          new Map(ids.map((i) => [i, `path/${i}`])),
      ),
    };
    const media = {
      imagesById: vi.fn(async () => new Map([['img', { url: 'u' }]])),
    };
    return {
      q: new CmsQuery(prisma as never, urls as never, media as never),
      prisma,
      urls,
      media,
    };
  }

  it('prefers store blocks and renders nested tokens', async () => {
    const { q, prisma } = setup();
    expect((await q.blocks(ctx, [])).size).toBe(0);
    prisma.block.findMany.mockImplementation(async ({ where }) =>
      [
        {
          identifier: 'a',
          storeId: null,
          translations: en({ title: 'G', content: 'global' }),
        },
        {
          identifier: 'a',
          storeId: 's1',
          translations: en({ title: 'S', content: 'S{{block id="b"}}' }),
        },
        {
          identifier: 'b',
          storeId: null,
          translations: en({ title: null, content: 'B' }),
        },
        { identifier: 'c', storeId: null, translations: [] },
      ].filter((b) => where.identifier.in.includes(b.identifier)),
    );
    expect(await q.block(ctx, 'a')).toEqual({
      identifier: 'a',
      title: 'S',
      content: 'SB',
    });
    expect(await q.block(ctx, 'c')).toBeUndefined();
  });

  it('groups placed blocks by region', async () => {
    const { q, prisma } = setup();
    prisma.blockPlacement.findMany.mockResolvedValue([
      {
        region: 'side',
        block: {
          identifier: 'x',
          translations: en({ title: null, content: 'X' }),
        },
      },
      {
        region: 'side',
        block: {
          identifier: 'y',
          translations: en({ title: 'Y', content: 'Y' }),
        },
      },
      { region: 'top', block: { identifier: 'z', translations: [] } },
    ]);
    expect(await q.regions(ctx, 'PAGE', 'p')).toEqual([
      {
        region: 'side',
        blocks: [
          { identifier: 'x', title: null, content: 'X' },
          { identifier: 'y', title: 'Y', content: 'Y' },
        ],
      },
    ]);
  });

  const page = (id: string, storeId: string | null, slug: string) => ({
    id,
    storeId,
    layout: 'default',
    publishedAt: null,
    updatedAt: new Date(),
    translations: en({
      title: id,
      slug,
      content: '<p>c</p>',
      metaTitle: null,
      metaDescription: null,
    }),
  });

  it('finds pages by id or path (the store page wins)', async () => {
    const { q, prisma } = setup();
    prisma.page.findFirst.mockResolvedValueOnce(null);
    expect(await q.page(ctx, 'x')).toBeUndefined();
    prisma.page.findFirst.mockResolvedValueOnce(page('g', null, 'about'));
    expect(await q.page(ctx, 'g')).toMatchObject({
      id: 'g',
      urlPath: 'path/g',
      content: '<p>c</p>',
      regions: [],
    });
    prisma.page.findMany.mockResolvedValueOnce([
      page('g', null, 'about'),
      page('l', 's1', 'about'),
    ]);
    expect((await q.pageByPath(ctx, '/About/'))?.id).toBe('l');
    prisma.page.findMany.mockResolvedValueOnce([
      { ...page('g', null, 'x'), translations: [] },
    ]);
    expect(await q.pageByPath(ctx, 'x')).toBeUndefined();
    prisma.page.findFirst.mockResolvedValueOnce({
      ...page('g', null, 'x'),
      translations: [],
    });
    expect(await q.page(ctx, 'g')).toBeUndefined();
  });

  const post = (
    id: string,
    storeId: string | null,
    slug: string,
    extra: object = {},
  ) => ({
    id,
    storeId,
    publishedAt: new Date(),
    featuredImageId: 'img',
    tags: [
      { tag: { code: 'b', translations: en({ name: 'Beta' }) } },
      { tag: { code: 'a', translations: en({ name: 'Alpha' }) } },
      { tag: { code: 'n', translations: [] } },
    ],
    translations: en({
      title: id,
      slug,
      excerpt: null,
      content: 'C',
      metaTitle: null,
      metaDescription: null,
    }),
    ...extra,
  });

  it('lists posts as cards and shows one by id or slug', async () => {
    const { q, prisma } = setup();
    prisma.post.findMany.mockResolvedValueOnce([
      post('p1', null, 'one'),
      post('p2', null, 'two', { translations: [], featuredImageId: null }),
    ]);
    prisma.post.count.mockResolvedValueOnce(2);
    const list = await q.posts(ctx, {
      page: 1,
      limit: 10,
      order: 'desc',
      skip: 0,
      tag: 'a',
    } as never);
    expect(list.total).toBe(2);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      featuredImage: { url: 'u' },
      urlPath: 'path/p1',
      tags: [
        { code: 'a', name: 'Alpha' },
        { code: 'b', name: 'Beta' },
      ],
    });
    await q.posts(ctx, { page: 1, limit: 10, order: 'desc', skip: 0 } as never);
    prisma.post.findFirst.mockResolvedValueOnce(null);
    expect(await q.post(ctx, 'x')).toBeUndefined();
    prisma.post.findFirst.mockResolvedValueOnce(post('p1', null, 'one'));
    expect((await q.post(ctx, 'p1'))?.content).toBe('C');
    prisma.post.findFirst.mockResolvedValueOnce(
      post('p1', null, 'one', { translations: [] }),
    );
    expect(await q.post(ctx, 'p1')).toBeUndefined();
    prisma.post.findMany.mockResolvedValueOnce([
      post('g', null, 'one'),
      post('l', 's1', 'one'),
    ]);
    expect((await q.postBySlug(ctx, 'one'))?.id).toBe('l');
    prisma.post.findMany.mockResolvedValueOnce([]);
    expect(await q.postBySlug(ctx, 'none')).toBeUndefined();
  });

  it('answers visible titles and existence for other modules', async () => {
    const { q, prisma } = setup();
    expect((await q.visibleTitles(ctx, 'page', [])).size).toBe(0);
    expect((await q.existing('post', [])).size).toBe(0);
    prisma.page.findMany.mockResolvedValueOnce([
      { id: 'a', translations: en({ title: 'A' }) },
      { id: 'b', translations: [] },
    ]);
    expect([...(await q.visibleTitles(ctx, 'page', ['a', 'b']))]).toEqual([
      ['a', 'A'],
    ]);
    prisma.post.findMany.mockResolvedValueOnce([
      { id: 'p', translations: en({ title: 'P' }) },
    ]);
    expect((await q.visibleTitles(ctx, 'post', ['p'])).get('p')).toBe('P');
    prisma.page.findMany.mockResolvedValueOnce([{ id: 'a' }]);
    expect([...(await q.existing('page', ['a', 'z']))]).toEqual(['a']);
    prisma.post.findMany.mockResolvedValueOnce([{ id: 'p' }]);
    expect((await q.existing('post', ['p'])).has('p')).toBe(true);
  });
});

describe('CmsUrlsService', () => {
  function setup() {
    const prisma = fakePrisma();
    const rewrites = {
      sync: vi.fn(
        async (_t: { type: string; id: string }, _d: { path: string }[]) =>
          undefined,
      ),
    };
    const stores = {
      snapshot: vi.fn(async () => ({
        byId: new Map([
          [
            's1',
            {
              id: 's1',
              websiteId: 'w',
              defaultLocaleCode: 'en-US',
              localeCodes: ['en-US'],
            },
          ],
          [
            's2',
            {
              id: 's2',
              websiteId: 'w',
              defaultLocaleCode: 'en-US',
              localeCodes: ['en-US'],
            },
          ],
        ]),
        fallbacks: new Map([['en-US', null]]),
      })),
    };
    return {
      svc: new CmsUrlsService(
        prisma as never,
        rewrites as never,
        stores as never,
      ),
      prisma,
      rewrites,
    };
  }
  const item = (id: string, storeId: string | null, slug = 'about') => ({
    id,
    storeId,
    translations: [{ localeCode: 'en-US', slug }],
  });
  const synced = (r: { sync: ReturnType<typeof vi.fn> }) =>
    r.sync.mock.calls.map((c) => [
      c[0].id,
      (c[1] as { storeId: string }[]).map((d) => d.storeId),
    ]);

  it('global content: one rebuild, shadowed stores excluded', async () => {
    const { svc, prisma, rewrites } = setup();
    prisma.page.findMany
      .mockResolvedValueOnce([item('g', null)])
      .mockResolvedValueOnce([item('l', 's1')]);
    await svc.rebuild('page', 'g', null);
    expect(synced(rewrites)).toEqual([['g', ['s2']]]);
    expect(rewrites.sync.mock.calls[0][0].type).toBe('CMS_PAGE');
  });

  it('store content releases global paths before claiming, and gives them back when it leaves', async () => {
    const { svc, prisma, rewrites } = setup();
    // live store post → globals first, then the post
    prisma.post.findMany
      .mockResolvedValueOnce([item('l', 's1')]) // item
      .mockResolvedValueOnce([item('g', null)]) // globals
      .mockResolvedValueOnce([item('g', null)]) // rebuildOne(g): live
      .mockResolvedValueOnce([item('l', 's1')]) // shadows
      .mockResolvedValueOnce([item('l', 's1')]); // rebuildOne(l)
    await svc.rebuild('post', 'l', 's1', ['old']);
    expect(synced(rewrites)).toEqual([
      ['g', ['s2']],
      ['l', ['s1']],
    ]);
    expect(rewrites.sync.mock.calls[1][1][0].path).toBe('blog/about');
    rewrites.sync.mockClear();
    // deleted store page → itself first (no paths), then the global one everywhere
    prisma.page.findMany
      .mockResolvedValueOnce([]) // item gone
      .mockResolvedValueOnce([item('g', null)]) // globals by previous slug
      .mockResolvedValueOnce([]) // rebuildOne(l)
      .mockResolvedValueOnce([item('g', null)]) // rebuildOne(g)
      .mockResolvedValueOnce([]); // shadows
    await svc.rebuild('page', 'l', 's1', ['about']);
    expect(synced(rewrites)).toEqual([
      ['l', []],
      ['g', ['s1', 's2']],
    ]);
    rewrites.sync.mockClear();
    prisma.page.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await svc.rebuild('page', 'x', 's1');
    expect(synced(rewrites)).toEqual([['x', []]]);
  });

  it('rebuilds everything globals-first', async () => {
    const { svc, prisma, rewrites } = setup();
    prisma.page.findMany.mockResolvedValue([]);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.page.findMany.mockResolvedValueOnce([
      item('l', 's1'),
      item('g', null),
    ]);
    expect(await svc.rebuildAll()).toBe(2);
    expect(rewrites.sync.mock.calls.map((c) => c[0].id)).toEqual(['g', 'l']);
  });
});

describe('CMS listeners', () => {
  it('rebuilds URLs, applies due schedules and cleans placements', async () => {
    const urls = { rebuild: vi.fn(), rebuildAll: vi.fn() };
    const publisher = { due: vi.fn() };
    const blocks = { removePlacementsOf: vi.fn() };
    const l = new CmsListener(
      urls as never,
      publisher as never,
      blocks as never,
    );
    await l.onPage({
      data: { id: 'p', storeId: null, previousSlugs: ['a'] },
    } as never);
    await l.onPost({ data: { id: 'q', storeId: 's' } } as never);
    expect(urls.rebuild.mock.calls).toEqual([
      ['page', 'p', null, ['a']],
      ['post', 'q', 's', []],
    ]);
    for (const targetType of ['PAGE', 'POST', 'BLOCK', 'BANNER'])
      await l.onDue({
        data: { targetType, targetId: 't', action: 'PUBLISH' },
      } as never);
    expect(publisher.due.mock.calls.map((c) => c[0])).toEqual([
      'page',
      'post',
      'block',
    ]);
    await l.onStoreCreated();
    await l.onStoreUpdated({ data: { localesChanged: false } } as never);
    await l.onStoreUpdated({ data: { localesChanged: true } } as never);
    expect(urls.rebuildAll).toHaveBeenCalledTimes(2);
    await l.onCategoryDeleted({ data: { categoryId: 'c' } } as never);
    expect(blocks.removePlacementsOf).toHaveBeenCalledWith('CATEGORY', 'c');
  });

  it('vetoes page and post slugs that are someone else’s URL', async () => {
    const urls = { taken: vi.fn(async () => []) };
    const l = new CmsUrlCollisionListener(urls as never);
    await l.onPageWrite({
      entityId: null,
      input: { storeId: null, slugs: [] },
    } as never);
    await l.onPageWrite({ entityId: null } as never);
    expect(urls.taken).not.toHaveBeenCalled();
    await l.onPostWrite({
      entityId: 'p',
      input: { storeId: 's', slugs: [{ localeCode: 'en-US', slug: 'x' }] },
    } as never);
    expect(urls.taken).toHaveBeenCalledWith(
      'CMS_POST',
      'p',
      [{ localeCode: 'en-US', path: 'blog/x' }],
      { storeId: 's', ignoreType: 'CMS_POST' },
    );
    urls.taken.mockResolvedValueOnce([
      { requestPath: 'men', localeCode: 'en-US', targetType: 'CATEGORY' },
    ] as never);
    await expect(
      l.onPageWrite({
        entityId: null,
        input: { storeId: null, slugs: [{ localeCode: 'en-US', slug: 'men' }] },
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CMS controllers', () => {
  it('delegate to their services; storefront 404s when nothing is visible', async () => {
    for (const C of [
      PagesController,
      PostsController,
      TagsController,
      BlocksController,
    ])
      expect(
        (await exerciseController(new C(stubService() as never))).failed,
      ).toBe(0);
    for (const C of [
      StorefrontPagesController,
      StorefrontPostsController,
      StorefrontBlocksController,
    ]) {
      expect(
        (await exerciseController(new C(stubService() as never))).failed,
      ).toBe(0);
      const missing = await exerciseController(
        new C(stubService(undefined) as never),
      );
      expect(missing.failed).toBeGreaterThan(0);
    }
  });
});
