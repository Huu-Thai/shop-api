import { BadRequestException, NotFoundException } from '@nestjs/common';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import type { StoreContext } from '../stores/context/store-context.js';
import {
  buildVisibleTree,
  createsCycle,
  depthOf,
  treeOrder,
} from './menu-tree.js';
import { MenusQuery } from './menus.query.js';
import {
  MAX_MENU_DEPTH,
  MenusService,
  normalizeLink,
} from './menus.service.js';
import {
  MenusController,
  StorefrontMenusController,
} from './navigation.controllers.js';
import { NavigationListener } from './navigation.listener.js';

const item = (id: string, parentId: string | null, position: number) => ({
  id,
  parentId,
  position,
});

describe('menu trees', () => {
  const items = [
    item('c', 'a', 0),
    item('b', null, 1),
    item('a', null, 0),
    item('d', 'c', 0),
  ];
  const parents = new Map(items.map((i) => [i.id, i.parentId]));

  it('orders depth-first, measures depth and detects cycles', () => {
    expect(treeOrder(items).map((i) => i.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(depthOf(null, parents)).toBe(1);
    expect(depthOf('c', parents)).toBe(3);
    expect(createsCycle('a', 'd', parents)).toBe(true);
    expect(createsCycle('d', 'b', parents)).toBe(false);
  });

  it('drops hidden items with their subtrees', () => {
    const tree = buildVisibleTree(items, (i) => i.id !== 'c');
    expect(tree.map((n) => [n.item.id, n.children.length])).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('normalizes links', () => {
    expect(normalizeLink('URL', 'x', '/sale')).toEqual({
      linkType: 'URL',
      targetId: null,
      url: '/sale',
    });
    expect(normalizeLink('PAGE', 'p', '/x')).toEqual({
      linkType: 'PAGE',
      targetId: 'p',
      url: null,
    });
    expect(() => normalizeLink('URL', undefined, undefined)).toThrow(
      BadRequestException,
    );
    expect(() => normalizeLink('PRODUCT', undefined, undefined)).toThrow(
      BadRequestException,
    );
  });
});

describe('MenusService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const cms = {
      existing: vi.fn(async (_k: string, ids: string[]) => new Set(ids)),
    };
    const categories = { byIds: vi.fn(async () => new Map()) };
    const products = { existing: vi.fn(async (ids: string[]) => new Set(ids)) };
    return {
      svc: new MenusService(
        prisma as never,
        fb.bus,
        cms as never,
        categories as never,
        products as never,
      ),
      prisma,
      cms,
      ...fb,
    };
  }
  const menu = { id: 'm', code: 'main', name: 'Main', storeId: null };

  it('menu CRUD', async () => {
    const { svc, prisma, afterNames } = setup();
    await svc.list();
    prisma.menu.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('m')).rejects.toBeInstanceOf(NotFoundException);
    prisma.menu.findUnique.mockResolvedValueOnce({
      ...menu,
      items: [
        {
          ...item('b', 'a', 0),
          translations: [{ localeCode: 'en-US', label: 'B' }],
        },
        { ...item('a', null, 0), translations: [] },
      ],
    });
    expect(
      (await svc.get('m')).items.map((i) => [i.id, i.labels.length]),
    ).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    prisma.menu.create.mockResolvedValue(menu);
    await svc.create({ code: 'main', name: 'Main' }, ROOT);
    prisma.menu.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('m', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.menu.findUnique.mockResolvedValue(menu);
    prisma.menu.update
      .mockResolvedValueOnce(menu)
      .mockResolvedValueOnce({ ...menu, name: 'Top' });
    await svc.update('m', { name: 'Main' }, ROOT);
    await svc.update('m', { name: 'Top' }, ROOT);
    await svc.remove('m', ROOT);
    prisma.menu.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('m', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(afterNames()).toEqual([
      'menu.created',
      'menu.updated',
      'menu.deleted',
    ]);
  });

  it('adds items with valid targets, parents and depth', async () => {
    const { svc, prisma, cms } = setup();
    const row = {
      ...item('i', null, 0),
      menuId: 'm',
      linkType: 'URL',
      translations: [],
    };
    prisma.menuItem.create.mockResolvedValue(row);
    prisma.menu.findUnique.mockResolvedValue({ id: 'm' });
    await svc.addItem(
      'm',
      {
        linkType: 'URL',
        url: '/sale',
        labels: [{ localeCode: 'en-US', label: 'Sale' }],
      },
      ROOT,
    );
    await svc.addItem('m', { linkType: 'POST', targetId: 'p' }, ROOT);
    await svc.addItem('m', { linkType: 'PRODUCT', targetId: 'p' }, ROOT);
    cms.existing.mockResolvedValueOnce(new Set());
    await expect(
      svc.addItem('m', { linkType: 'PAGE', targetId: 'gone' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.addItem('m', { linkType: 'CATEGORY', targetId: 'c' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.addItem('m', { linkType: 'URL', url: '/x', parentId: 'other' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    // A chain already MAX deep cannot get another level.
    prisma.menuItem.findMany.mockResolvedValueOnce(
      Array.from({ length: MAX_MENU_DEPTH }, (_, i) => ({
        id: `l${i}`,
        parentId: i ? `l${i - 1}` : null,
      })),
    );
    await expect(
      svc.addItem(
        'm',
        { linkType: 'URL', url: '/x', parentId: `l${MAX_MENU_DEPTH - 1}` },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.menu.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.addItem('m', { linkType: 'URL', url: '/x' }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates, moves (no cycles, depth kept) and removes items', async () => {
    const { svc, prisma, after } = setup();
    const row = {
      ...item('a', null, 0),
      menuId: 'm',
      linkType: 'PAGE',
      targetId: 'p',
      url: null,
      openInNewTab: false,
      isActive: true,
      translations: [],
    };
    prisma.menuItem.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateItem('a', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.menuItem.findUnique.mockResolvedValue(row);
    prisma.menu.findUnique.mockResolvedValue({ id: 'm' });
    prisma.menuItem.findMany.mockResolvedValue([
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: null },
    ]);
    await expect(
      svc.updateItem('a', { parentId: 'b' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.menuItem.update.mockResolvedValueOnce({
      ...row,
      parentId: 'c',
      isActive: false,
    });
    await svc.updateItem(
      'a',
      {
        parentId: 'c',
        isActive: false,
        labels: [{ localeCode: 'en-US', label: 'A' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    expect(after.at(-1)).toMatchObject({ name: 'menu-item.updated' });
    // Switching to a URL link clears the target; switching type requires the new target.
    prisma.menuItem.update.mockResolvedValueOnce(row);
    await svc.updateItem('a', { linkType: 'URL', url: '/x' }, ROOT);
    expect(prisma.menuItem.update.mock.calls.at(-1)![0].data).toMatchObject({
      linkType: 'URL',
      targetId: null,
      url: '/x',
    });
    await expect(
      svc.updateItem('a', { linkType: 'PRODUCT' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.menuItem.update.mockResolvedValueOnce(row);
    await svc.updateItem('a', { targetId: 'p2' }, ROOT);
    const deep = Array.from({ length: MAX_MENU_DEPTH }, (_, i) => ({
      id: `l${i}`,
      parentId: i ? `l${i - 1}` : null,
    }));
    prisma.menuItem.findMany.mockResolvedValueOnce([
      ...deep,
      { id: 'a', parentId: null },
      { id: 'k', parentId: 'a' },
    ]);
    await expect(
      svc.updateItem('a', { parentId: 'l3' }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.menuItem.findUnique.mockResolvedValueOnce(null);
    await expect(svc.removeItem('a', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.menuItem.findUnique.mockResolvedValueOnce({ menuId: 'm' });
    await svc.removeItem('a', ROOT);
    expect(after.at(-1)).toMatchObject({ name: 'menu-item.deleted' });
  });

  it('deactivates links to deleted targets', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.menuItem.findMany.mockResolvedValueOnce([]);
    expect(await svc.deactivateLinksTo('PAGE', 'p')).toBe(0);
    prisma.menuItem.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await svc.deactivateLinksTo('PAGE', 'p')).toBe(2);
    expect(afterNames()).toEqual(['menu-item.updated', 'menu-item.updated']);
  });
});

describe('MenusQuery', () => {
  const ctx = {
    storeId: 's1',
    websiteId: 'w',
    localeChain: ['en-US'],
  } as StoreContext;

  it('resolves links per target type and hides what the store cannot show', async () => {
    const prisma = fakePrisma();
    prisma.menu.findMany.mockResolvedValueOnce([]);
    const cms = {
      visibleTitles: vi.fn(
        async (_c: unknown, kind: string) =>
          new Map(kind === 'page' ? [['pg', 'Help']] : [['po', 'News']]),
      ),
    };
    const categories = {
      visible: vi.fn(async () => new Map([['c', { name: 'Men' }]])),
    };
    const products = {
      visibleIds: vi.fn(async () => ['pr']),
      summaries: vi.fn(async () => [{ id: 'pr', name: 'Tee' }]),
    };
    const urls = {
      canonicalPaths: vi.fn(
        async (_c: unknown, _t: string, ids: string[]) =>
          new Map(ids.filter((i) => i !== 'c2').map((i) => [i, `p/${i}`])),
      ),
    };
    const q = new MenusQuery(
      prisma as never,
      cms as never,
      categories as never,
      products as never,
      urls as never,
    );
    expect(await q.menu(ctx, 'main')).toBeUndefined();
    prisma.menu.findMany.mockResolvedValueOnce([
      { id: 'g', code: 'main', name: 'Global', storeId: null },
      { id: 'l', code: 'main', name: 'Local', storeId: 's1' },
    ]);
    const it = (
      id: string,
      linkType: string,
      targetId: string | null,
      extra: object = {},
    ) => ({
      id,
      parentId: null,
      position: 0,
      linkType,
      targetId,
      url: null,
      openInNewTab: false,
      isActive: true,
      translations: [],
      ...extra,
    });
    prisma.menuItem.findMany.mockResolvedValueOnce([
      it('1', 'PAGE', 'pg'),
      it('2', 'POST', 'po', {
        translations: [{ localeCode: 'en-US', label: 'Blog' }],
      }),
      it('3', 'CATEGORY', 'c', { position: 1 }),
      it('4', 'CATEGORY', 'c2', { position: 2 }),
      it('5', 'PRODUCT', 'pr', { position: 3 }),
      it('6', 'URL', null, { url: '/sale', position: 4 }),
      it('7', 'URL', null, { url: '/x', isActive: false, position: 5 }),
      it('8', 'PAGE', 'hidden', { parentId: '1' }),
    ]);
    const m = await q.menu(ctx, 'main');
    expect(m?.name).toBe('Local');
    expect(prisma.menuItem.findMany.mock.calls[0][0].where.menuId).toBe('l');
    expect(m?.items.map((i) => [i.label, i.url])).toEqual([
      ['Help', '/p/pg'],
      ['Blog', '/p/po'],
      ['Men', '/p/c'],
      ['Tee', '/p/pr'],
    ]);
  });

  it('skips lookups when a menu has no links of a type', async () => {
    const prisma = fakePrisma();
    prisma.menu.findMany.mockResolvedValueOnce([
      { id: 'g', code: 'main', name: 'Global', storeId: null },
    ]);
    prisma.menuItem.findMany.mockResolvedValueOnce([]);
    const none = vi.fn();
    const q = new MenusQuery(
      prisma as never,
      { visibleTitles: none } as never,
      { visible: none } as never,
      { visibleIds: none } as never,
      { canonicalPaths: none } as never,
    );
    expect((await q.menu(ctx, 'main'))?.items).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });
});

describe('navigation wiring', () => {
  it('listener deactivates links; controllers delegate', async () => {
    const menus = { deactivateLinksTo: vi.fn() };
    const l = new NavigationListener(menus as never);
    await l.onPageDeleted({ data: { id: 'p' } } as never);
    await l.onPostDeleted({ data: { id: 'q' } } as never);
    await l.onCategoryDeleted({ data: { categoryId: 'c' } } as never);
    expect(menus.deactivateLinksTo.mock.calls).toEqual([
      ['PAGE', 'p'],
      ['POST', 'q'],
      ['CATEGORY', 'c'],
    ]);
    expect(
      (await exerciseController(new MenusController(stubService() as never)))
        .failed,
    ).toBe(0);
    expect(
      (
        await exerciseController(
          new StorefrontMenusController(stubService() as never),
        )
      ).failed,
    ).toBe(0);
    expect(
      (
        await exerciseController(
          new StorefrontMenusController(stubService(undefined) as never),
        )
      ).failed,
    ).toBe(1);
  });
});
