import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { BlocksService } from './blocks.service.js';
import { pageSlug, PagesService } from './pages.service.js';
import { PostsService } from './posts.service.js';
import { TagsService } from './tags.service.js';

const q = (extra: object = {}) =>
  ({ page: 1, limit: 25, order: 'desc', skip: 0, ...extra }) as never;

function base() {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  const publisher = {
    change: vi.fn(async (..._a: unknown[]) => undefined),
    cancelSchedules: vi.fn(),
  };
  return { prisma, publisher, ...fb };
}

const pageRow = (over: object = {}) => ({
  id: 'p',
  storeId: null,
  status: 'DRAFT',
  layout: 'default',
  publishedAt: null,
  unpublishedAt: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  translations: [
    { localeCode: 'en-US', title: 'About', slug: 'about', content: '' },
  ],
  ...over,
});

describe('PagesService', () => {
  function setup() {
    const b = base();
    return {
      svc: new PagesService(b.prisma as never, b.bus, b.publisher as never),
      ...b,
    };
  }

  it('validates slugs (segments allowed) or derives them from the title', () => {
    expect(pageSlug('Shipping & Returns', undefined, 'x')).toBe(
      'shipping-returns',
    );
    expect(pageSlug('x', '/help/shipping/', 'x')).toBe('help/shipping');
    expect(() => pageSlug('x', 'Help Me', 'x')).toThrow(BadRequestException);
    expect(() => pageSlug('!!!', undefined, 'x')).toThrow(BadRequestException);
  });

  it('creates drafts with sanitized content and tells the URL veto the slugs', async () => {
    const { svc, prisma, before, afterNames } = setup();
    await expect(svc.create({ translations: [] }, ROOT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.page.create.mockResolvedValue(pageRow());
    const r = await svc.create(
      {
        storeId: 's1',
        translations: [
          {
            localeCode: 'en-US',
            title: 'About',
            content: '<p>x</p><script>1</script>',
            metaTitle: ' ',
          },
        ],
      },
      ROOT,
    );
    expect(r.visible).toBe(false);
    expect(before[0]).toMatchObject({
      input: { storeId: 's1', slugs: [{ localeCode: 'en-US', slug: 'about' }] },
    });
    const data = prisma.page.create.mock.calls[0][0].data;
    expect(data.translations.create[0]).toMatchObject({
      content: '<p>x</p>',
      metaTitle: null,
    });
    expect(data.createdById).toBe(ROOT.id);
    expect(afterNames()).toEqual(['page.created']);
    prisma.pageTranslation.findFirst.mockResolvedValue({
      localeCode: 'en-US',
      slug: 'about',
    });
    await expect(
      svc.create(
        { translations: [{ localeCode: 'en-US', title: 'About' }] },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates translations, keeps at least one, and reports slug changes', async () => {
    const { svc, prisma, after } = setup();
    prisma.page.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.page.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(null);
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.page.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(pageRow());
    prisma.pageTranslation.count.mockResolvedValueOnce(0);
    await expect(
      svc.update('p', { removeLocales: ['en-US'] }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.page.findUnique
      .mockResolvedValueOnce({ storeId: 's' })
      .mockResolvedValueOnce(pageRow());
    prisma.pageTranslation.count.mockResolvedValueOnce(1);
    prisma.page.update.mockResolvedValueOnce(
      pageRow({
        layout: 'wide',
        translations: [
          { localeCode: 'en-US', title: 'Us', slug: 'us', content: '' },
        ],
      }),
    );
    await svc.update(
      'p',
      {
        layout: 'wide',
        translations: [{ localeCode: 'en-US', title: 'Us' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    expect(prisma.pageTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(after[0]).toMatchObject({
      name: 'page.updated',
      audit: {
        changes: {
          layout: { from: 'default', to: 'wide' },
          slugs: { from: ['en-US:about'], to: ['en-US:us'] },
        },
      },
      data: { previousSlugs: ['about'] },
    });
    prisma.page.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(pageRow());
    prisma.pageTranslation.count.mockResolvedValueOnce(1);
    prisma.page.update.mockResolvedValueOnce(pageRow());
    await svc.update('p', {}, ROOT);
    expect(after[1]).toMatchObject({ audit: { changes: {} } });
  });

  it('deletes with its placements and schedules; lists, gets and publishes', async () => {
    const { svc, prisma, publisher, afterNames } = setup();
    prisma.page.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('p', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.page.findUnique.mockResolvedValueOnce(pageRow());
    await svc.remove('p', ROOT);
    expect(prisma.blockPlacement.deleteMany).toHaveBeenCalledWith({
      where: { targetType: 'PAGE', targetId: 'p' },
    });
    expect(publisher.cancelSchedules).toHaveBeenCalled();
    expect(afterNames()).toEqual(['page.deleted']);

    prisma.page.findMany.mockResolvedValue([pageRow()]);
    prisma.page.count.mockResolvedValue(1);
    const list = await svc.list(q({ storeId: 'global', search: 'Ab' }));
    expect(list.total).toBe(1);
    expect(prisma.page.findMany.mock.calls[0][0].where.storeId).toBeNull();
    await svc.list(q());

    prisma.page.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('p')).rejects.toBeInstanceOf(NotFoundException);
    prisma.page.findUnique.mockResolvedValue(pageRow());
    await svc.publish('p', 'publish', '2026-11-01T00:00:00Z', ROOT);
    await svc.publish('p', 'unpublish', undefined, ROOT);
    expect(publisher.change.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      ['publish', new Date('2026-11-01T00:00:00Z')],
      ['unpublish', undefined],
    ]);
  });
});

const postRow = (over: object = {}) => ({
  ...pageRow(),
  authorId: null,
  featuredImageId: null,
  tags: [{ tagId: 't2' }, { tagId: 't1' }],
  ...over,
});

describe('PostsService', () => {
  function setup() {
    const b = base();
    return {
      svc: new PostsService(b.prisma as never, b.bus, b.publisher as never),
      ...b,
    };
  }

  it('creates posts with tags (which must exist) and unique slugs', async () => {
    const { svc, prisma, afterNames } = setup();
    await expect(svc.create({ translations: [] }, ROOT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.tag.count.mockResolvedValueOnce(1);
    await expect(
      svc.create(
        {
          tagIds: ['t1', 't2'],
          translations: [{ localeCode: 'en-US', title: 'Hi' }],
        },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.tag.count.mockResolvedValueOnce(2);
    prisma.post.create.mockResolvedValue(postRow());
    const r = await svc.create(
      {
        tagIds: ['t1', 't2', 't1'],
        featuredImageId: 'img',
        translations: [{ localeCode: 'en-US', title: 'Hi', excerpt: ' x ' }],
      },
      ROOT,
    );
    expect(r.tagIds).toEqual(['t1', 't2']);
    const data = prisma.post.create.mock.calls[0][0].data;
    expect(data.tags.create).toHaveLength(2);
    expect(data.translations.create[0]).toMatchObject({
      slug: 'hi',
      excerpt: 'x',
    });
    expect(afterNames()).toEqual(['post.created']);
    prisma.postTranslation.findFirst.mockResolvedValue({
      localeCode: 'en-US',
      slug: 'hi',
    });
    await expect(
      svc.create(
        { translations: [{ localeCode: 'en-US', title: 'Hi' }] },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates tags, image and translations', async () => {
    const { svc, prisma, after } = setup();
    prisma.post.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.post.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(null);
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.post.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(postRow());
    await expect(svc.update('p', {}, ROOT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.post.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(postRow());
    prisma.postTranslation.count.mockResolvedValue(1);
    prisma.tag.count.mockResolvedValue(1);
    prisma.post.update.mockResolvedValueOnce(
      postRow({
        featuredImageId: 'img',
        tags: [{ tagId: 't3' }],
        translations: [
          { localeCode: 'en-US', title: 'New', slug: 'new', content: '' },
        ],
      }),
    );
    await svc.update(
      'p',
      {
        featuredImageId: 'img',
        tagIds: ['t3'],
        translations: [{ localeCode: 'en-US', title: 'New' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    expect(prisma.postTag.deleteMany).toHaveBeenCalledWith({
      where: { postId: 'p', tagId: { notIn: ['t3'] } },
    });
    expect(
      Object.keys(
        (after[0] as never as { audit: { changes: object } }).audit.changes,
      ),
    ).toEqual([
      'featuredImageId',
      'tagIds',
      'slugs',
      'translations',
      'removedLocales',
    ]);
    prisma.post.findUnique
      .mockResolvedValueOnce({ storeId: null })
      .mockResolvedValueOnce(postRow());
    prisma.post.update.mockResolvedValueOnce(postRow());
    await svc.update('p', {}, ROOT);
    expect(
      (after[1] as never as { audit: { changes: object } }).audit.changes,
    ).toEqual({});
  });

  it('deletes, lists, gets and publishes', async () => {
    const { svc, prisma, publisher, afterNames } = setup();
    prisma.post.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('p', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.post.findUnique.mockResolvedValueOnce(postRow());
    await svc.remove('p', ROOT);
    expect(afterNames()).toEqual(['post.deleted']);
    prisma.post.findMany.mockResolvedValue([postRow()]);
    await svc.list(q({ tagId: 't', search: 'x', storeId: 's' }));
    await svc.list(q());
    prisma.post.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('p')).rejects.toBeInstanceOf(NotFoundException);
    prisma.post.findUnique.mockResolvedValue(postRow());
    await svc.publish('p', 'publish', undefined, ROOT);
    await svc.publish('p', 'publish', '2026-11-01T00:00:00Z', ROOT);
    expect(publisher.change).toHaveBeenCalledTimes(2);
  });
});

describe('TagsService', () => {
  it('creates, renames, keeps one name and deletes', async () => {
    const { prisma, bus, afterNames } = base();
    const svc = new TagsService(prisma as never, bus);
    await svc.list();
    prisma.tag.create.mockResolvedValue({ id: 't', code: 'news' });
    await svc.create(
      { code: 'news', translations: [{ localeCode: 'en-US', name: 'News' }] },
      ROOT,
    );
    prisma.tag.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('t', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.tag.findUnique.mockResolvedValueOnce({ id: 't' });
    await expect(
      svc.update('t', { removeLocales: ['en-US'] }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.tag.findUnique.mockResolvedValueOnce({ id: 't' });
    prisma.tagTranslation.count.mockResolvedValueOnce(1);
    await svc.update(
      't',
      { translations: [{ localeCode: 'vi-VN', name: 'Tin' }] },
      ROOT,
    );
    prisma.tag.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('t', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.tag.findUnique.mockResolvedValueOnce({ id: 't', code: 'news' });
    await svc.remove('t', ROOT);
    expect(afterNames()).toEqual(['tag.created', 'tag.updated', 'tag.deleted']);
  });
});

describe('BlocksService', () => {
  function setup() {
    const b = base();
    const categories = {
      byIds: vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, {}]))),
    };
    const products = { existing: vi.fn(async () => new Set<string>()) };
    return {
      svc: new BlocksService(
        b.prisma as never,
        b.bus,
        b.publisher as never,
        categories as never,
        products as never,
      ),
      ...b,
    };
  }
  const blockRow = {
    id: 'b',
    identifier: 'promo',
    storeId: null,
    status: 'PUBLISHED',
    publishedAt: null,
    unpublishedAt: null,
    translations: [],
  };

  it('CRUD with sanitized translations', async () => {
    const { svc, prisma, publisher, afterNames } = setup();
    await expect(
      svc.create({ identifier: 'x', translations: [] }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.block.create.mockResolvedValue(blockRow);
    expect(
      (
        await svc.create(
          {
            identifier: 'promo',
            translations: [
              { localeCode: 'en-US', title: ' ', content: '<b>x</b><script/>' },
            ],
          },
          ROOT,
        )
      ).visible,
    ).toBe(true);
    expect(
      prisma.block.create.mock.calls[0][0].data.translations.create[0],
    ).toEqual({ localeCode: 'en-US', title: null, content: '<b>x</b>' });
    prisma.block.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('b', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.block.findUnique.mockResolvedValueOnce({ id: 'b' });
    await expect(svc.update('b', {}, ROOT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.block.findUnique.mockResolvedValueOnce({ id: 'b' });
    prisma.blockTranslation.count.mockResolvedValueOnce(1);
    prisma.block.update.mockResolvedValueOnce(blockRow);
    await svc.update(
      'b',
      {
        translations: [{ localeCode: 'en-US', content: 'y' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    prisma.block.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('b', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.block.findUnique.mockResolvedValueOnce({
      identifier: 'promo',
      storeId: null,
    });
    await svc.remove('b', ROOT);
    expect(publisher.cancelSchedules).toHaveBeenCalled();
    expect(afterNames()).toEqual([
      'block.created',
      'block.updated',
      'block.deleted',
    ]);

    prisma.block.findMany.mockResolvedValue([blockRow]);
    await svc.list(q({ search: 'PRO', storeId: 'global' }));
    await svc.list(q());
    prisma.block.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('b')).rejects.toBeInstanceOf(NotFoundException);
    prisma.block.findUnique.mockResolvedValue(blockRow);
    await svc.publish('b', 'publish', '2026-11-01T00:00:00Z', ROOT);
    await svc.publish('b', 'unpublish', undefined, ROOT);
    expect(publisher.change).toHaveBeenCalledTimes(2);
  });

  it('places blocks only on existing targets', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.block.findUnique.mockResolvedValue(blockRow);
    await svc.placements('b');
    const dto = (targetType: string) =>
      ({ targetType, targetId: 't', region: 'sidebar' }) as never;
    prisma.block.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.addPlacement('b', dto('PAGE'), ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.page.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.addPlacement('b', dto('PAGE'), ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.page.findUnique.mockResolvedValueOnce({ id: 't' });
    prisma.post.findUnique.mockResolvedValueOnce({ id: 't' });
    prisma.blockPlacement.create.mockImplementation(async ({ data }) => ({
      id: 'pl',
      ...data,
    }));
    await svc.addPlacement('b', dto('PAGE'), ROOT);
    await svc.addPlacement('b', dto('POST'), ROOT);
    await svc.addPlacement('b', dto('CATEGORY'), ROOT);
    await expect(
      svc.addPlacement('b', dto('PRODUCT'), ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.blockPlacement.create.mock.calls[0][0].data.position).toBe(0);
    prisma.blockPlacement.findUnique.mockResolvedValueOnce(null);
    await expect(svc.removePlacement('pl', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.blockPlacement.findUnique.mockResolvedValueOnce({
      id: 'pl',
      blockId: 'b',
      targetType: 'PAGE',
      targetId: 't',
      region: 'sidebar',
    });
    await svc.removePlacement('pl', ROOT);
    prisma.blockPlacement.deleteMany.mockResolvedValueOnce({ count: 2 });
    expect(await svc.removePlacementsOf('CATEGORY', 'c')).toBe(2);
    expect(afterNames()).toEqual([
      'block-placement.created',
      'block-placement.created',
      'block-placement.created',
      'block-placement.deleted',
    ]);
  });
});
