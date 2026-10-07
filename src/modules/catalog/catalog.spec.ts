import { ConflictException, NotFoundException } from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { AttributesQuery } from './attributes.query.js';
import { AttributesService } from './attributes.service.js';
import {
  breadcrumbs,
  CategoriesQuery,
  type VisibleCategory,
  visibleSubtree,
} from './categories.query.js';
import { CategoriesService } from './categories.service.js';
import { buildTree, idsInPath, isInSubtree, pathOf } from './category-tree.js';
import { CategoryImageOwnerListener } from './image-owner.listener.js';

const attrRow = (o: object = {}) => ({
  id: 'a1',
  code: 'color',
  type: 'SELECT',
  isRequired: false,
  isFilterable: true,
  isSearchable: false,
  isLocalizable: false,
  isVisible: true,
  position: 0,
  translations: [{ localeCode: 'en-US', label: 'Colour' }],
  options: [
    {
      code: 'red',
      swatch: '#f00',
      position: 0,
      translations: [{ localeCode: 'en-US', label: 'Red' }],
    },
  ],
  ...o,
});

describe('category tree helpers', () => {
  it('builds paths and subtree checks', () => {
    expect(pathOf(null, 'a')).toBe('a');
    expect(pathOf('a/b', 'c')).toBe('a/b/c');
    expect(idsInPath('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(isInSubtree('a/b/c', 'a/b')).toBe(true);
    expect(isInSubtree('a/bc', 'a/b')).toBe(false);
  });

  it('nests rows by parent and position, dropping orphans', () => {
    const tree = buildTree([
      { id: 'b', parentId: 'a', position: 2 },
      { id: 'a', parentId: null, position: 0 },
      { id: 'c', parentId: 'a', position: 1 },
      { id: 'orphan', parentId: 'gone', position: 0 },
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['c', 'b']);
  });

  it('subtrees and breadcrumbs over visible categories', () => {
    const v = (id: string, parentId: string | null) =>
      [
        id,
        { id, parentId, name: id.toUpperCase() } as VisibleCategory,
      ] as const;
    const visible = new Map([
      v('men', null),
      v('tees', 'men'),
      v('polo', 'tees'),
      v('women', null),
    ]);
    expect(visibleSubtree(visible, 'men')).toEqual(['men', 'tees', 'polo']);
    expect(breadcrumbs(visible, 'polo').map((c) => c.id)).toEqual([
      'men',
      'tees',
      'polo',
    ]);
  });
});

describe('AttributesService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new AttributesService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }

  it('creates attributes with labels and options', async () => {
    const { svc, prisma, before, afterNames } = setup();
    prisma.attribute.create.mockResolvedValue(attrRow());
    const a = await svc.create(
      {
        code: 'color',
        type: 'SELECT',
        labels: [{ localeCode: 'en-US', label: 'Colour' }],
        options: [
          { code: 'red', labels: [{ localeCode: 'en-US', label: 'Red' }] },
        ],
      },
      ROOT,
    );
    expect(a).toMatchObject({
      code: 'color',
      labels: [{ localeCode: 'en-US', label: 'Colour' }],
      options: [{ code: 'red', labels: [{ label: 'Red' }] }],
    });
    expect(before[0]).toMatchObject({
      name: 'attribute.before-write',
      input: { code: 'color', removedOptionCodes: [] },
    });
    expect(afterNames()).toEqual(['attribute.created']);
  });

  it('validates options, labels and localizability', async () => {
    const { svc } = setup();
    const labels = [{ localeCode: 'en-US', label: 'x' }];
    await expect(
      svc.create(
        { code: 'x', type: 'TEXT', labels, options: [{ code: 'a', labels }] },
        ROOT,
      ),
    ).rejects.toThrow('Only SELECT');
    await expect(
      svc.create(
        {
          code: 'x',
          type: 'SELECT',
          labels,
          options: [
            { code: 'a', labels },
            { code: 'a', labels },
          ],
        },
        ROOT,
      ),
    ).rejects.toThrow('Duplicate option');
    await expect(
      svc.create(
        { code: 'x', type: 'SELECT', isLocalizable: true, labels },
        ROOT,
      ),
    ).rejects.toThrow('not localizable');
    await expect(
      svc.create(
        { code: 'x', type: 'TEXT', labels: [...labels, ...labels] },
        ROOT,
      ),
    ).rejects.toThrow('duplicate locale');
  });

  it('update announces removed options (for the products veto) and syncs options by code', async () => {
    const { svc, prisma, before, afterNames } = setup();
    prisma.attribute.findUnique.mockResolvedValue(
      attrRow({
        options: [
          ...attrRow().options,
          { code: 'blue', swatch: null, position: 1, translations: [] },
        ],
      }),
    );
    prisma.attribute.findUniqueOrThrow.mockResolvedValue(attrRow());
    await svc.update(
      'a1',
      {
        options: [
          { code: 'red', labels: [{ localeCode: 'en-US', label: 'Red' }] },
        ],
      },
      ROOT,
    );
    expect(before[0]).toMatchObject({
      input: { removedOptionCodes: ['blue'] },
    });
    expect(prisma.attributeOption.deleteMany).toHaveBeenCalledWith({
      where: { attributeId: 'a1', code: { notIn: ['red'] } },
    });
    expect(prisma.attributeOption.upsert).toHaveBeenCalledTimes(1);
    expect(afterNames()).toEqual(['attribute.updated']);
    prisma.attribute.findUnique.mockResolvedValue(null);
    await expect(svc.update('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete announces every option; list', async () => {
    const { svc, prisma, before, afterNames } = setup();
    prisma.attribute.findUnique.mockResolvedValue({
      code: 'color',
      options: [{ code: 'red' }],
    });
    await svc.remove('a1', ROOT);
    expect(before[0]).toMatchObject({
      action: 'delete',
      input: { code: 'color', removedOptionCodes: ['red'] },
    });
    expect(afterNames()).toEqual(['attribute.deleted']);
    prisma.attribute.findMany.mockResolvedValue([attrRow()]);
    expect(await svc.list()).toHaveLength(1);
    prisma.attribute.findUnique.mockResolvedValue(null);
    await expect(svc.remove('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('attribute sets: members must exist and be unique', async () => {
    const { svc, prisma, afterNames } = setup();
    const set = {
      id: 's1',
      code: 'apparel',
      name: 'Apparel',
      attributes: [
        { groupName: 'General', position: 0, attribute: { code: 'color' } },
      ],
    };
    await expect(
      svc.createSet(
        {
          code: 'apparel',
          name: 'A',
          attributes: [{ code: 'color' }, { code: 'color' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('Duplicate');
    await expect(
      svc.createSet(
        { code: 'apparel', name: 'A', attributes: [{ code: 'nope' }] },
        ROOT,
      ),
    ).rejects.toThrow('Unknown attributes: nope');
    prisma.attribute.findMany.mockResolvedValue([{ id: 'a1', code: 'color' }]);
    prisma.attributeSet.create.mockResolvedValue(set);
    expect(
      await svc.createSet(
        { code: 'apparel', name: 'A', attributes: [{ code: 'color' }] },
        ROOT,
      ),
    ).toEqual({
      id: 's1',
      code: 'apparel',
      name: 'Apparel',
      attributes: [{ code: 'color', groupName: 'General', position: 0 }],
    });
    prisma.attributeSet.findUnique.mockResolvedValue(set);
    prisma.attributeSet.update.mockResolvedValue({ ...set, name: 'Clothes' });
    await svc.updateSet(
      's1',
      { name: 'Clothes', attributes: [{ code: 'color' }] },
      ROOT,
    );
    await svc.removeSet('s1', ROOT);
    expect(afterNames()).toEqual([
      'attribute-set.created',
      'attribute-set.updated',
      'attribute-set.deleted',
    ]);
    prisma.attributeSet.findMany.mockResolvedValue([set]);
    expect(await svc.listSets()).toHaveLength(1);
    expect((await svc.getSet('s1')).code).toBe('apparel');
    prisma.attributeSet.findUnique.mockResolvedValue(null);
    await expect(svc.getSet('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.updateSet('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.removeSet('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AttributesQuery', () => {
  it('returns set definitions, lookups and localized labels with fallbacks', async () => {
    const prisma = fakePrisma();
    const q = new AttributesQuery(prisma as never);
    expect(await q.setDefinitions('missing')).toBeUndefined();
    prisma.attributeSet.findUnique.mockResolvedValue({
      attributes: [{ attribute: { code: 'color' } }],
    });
    expect([...(await q.setDefinitions('s1'))!.keys()]).toEqual(['color']);
    prisma.attribute.findMany.mockResolvedValue([{ id: 'a1', code: 'color' }]);
    expect((await q.byCodes(['color'])).get('color')).toBeDefined();
    expect((await q.byIds(['a1'])).get('a1')).toBeDefined();
    expect(await q.localized([], ['en-US'])).toEqual(new Map());
    prisma.attribute.findMany.mockResolvedValue([
      attrRow({
        options: [
          {
            code: 'red',
            swatch: '#f00',
            position: 0,
            translations: [{ localeCode: 'vi-VN', label: 'Đỏ' }],
          },
          { code: 'blue', swatch: null, position: 1, translations: [] },
        ],
      }),
    ]);
    const l = (await q.localized(['color'], ['vi-VN', 'en-US'])).get('color')!;
    expect(l.label).toBe('Colour');
    expect(l.options.get('red')).toEqual({
      label: 'Đỏ',
      swatch: '#f00',
      position: 0,
    });
    expect(l.options.get('blue')?.label).toBe('blue');
    expect(l.def.options).toEqual([
      { code: 'red', swatch: '#f00', position: 0 },
      { code: 'blue', swatch: null, position: 1 },
    ]);
  });
});

describe('CategoriesService', () => {
  const row = (o: object = {}) => ({
    id: 'c1',
    parentId: null,
    path: 'c1',
    level: 0,
    position: 0,
    isActive: true,
    includeInMenu: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    translations: [
      {
        localeCode: 'en-US',
        name: 'Men',
        slug: 'men',
        description: null,
        metaTitle: null,
        metaDescription: null,
      },
    ],
    websites: [{ websiteId: 'w1' }],
    ...o,
  });
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new CategoriesService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }

  it('creates under a parent with a derived slug, path and level', async () => {
    const { svc, prisma, before, after } = setup();
    prisma.category.findUnique.mockResolvedValue({ path: 'root', level: 0 });
    prisma.category.create.mockImplementation(
      async ({ data }: { data: { id: string } }) =>
        row({
          id: data.id,
          path: `root/${data.id}`,
          level: 1,
          parentId: 'root',
        }),
    );
    const c = await svc.create(
      {
        parentId: 'root',
        translations: [{ localeCode: 'vi-VN', name: 'Áo thun' }],
        websiteIds: ['w1', 'w1'],
      },
      ROOT,
    );
    const data = prisma.category.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      path: `root/${data.id}`,
      level: 1,
      translations: { create: [expect.objectContaining({ slug: 'ao-thun' })] },
      websites: { create: [{ websiteId: 'w1' }] },
    });
    expect(before[0]).toMatchObject({
      input: {
        parentId: 'root',
        slugs: [{ localeCode: 'vi-VN', slug: 'ao-thun' }],
      },
    });
    expect(after[0]).toMatchObject({
      name: 'category.created',
      data: { urlsChanged: true },
    });
    expect(c.websiteIds).toEqual(['w1']);
  });

  it('rejects missing parents, depth overflow, sibling slug clashes and empty translations', async () => {
    const { svc, prisma } = setup();
    await expect(svc.create({ translations: [] }, ROOT)).rejects.toThrow(
      'At least one translation',
    );
    await expect(
      svc.create(
        {
          parentId: 'nope',
          translations: [{ localeCode: 'en-US', name: 'X' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('does not exist');
    prisma.category.findUnique.mockResolvedValue({ path: 'p', level: 9 });
    await expect(
      svc.create(
        {
          parentId: 'deep',
          translations: [{ localeCode: 'en-US', name: 'X' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('at most 10 levels');
    prisma.categoryTranslation.findMany.mockResolvedValue([
      { localeCode: 'en-US', slug: 'x' },
    ]);
    await expect(
      svc.create({ translations: [{ localeCode: 'en-US', name: 'X' }] }, ROOT),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.create(
        { translations: [{ localeCode: 'en-US', name: '日本' }] },
        ROOT,
      ),
    ).rejects.toThrow('send a slug');
  });

  it('update upserts translations and reports URL changes only when slugs or websites change', async () => {
    const { svc, prisma, after } = setup();
    prisma.category.findUnique.mockResolvedValue(row());
    prisma.categoryTranslation.count.mockResolvedValue(1);
    prisma.category.update
      .mockResolvedValueOnce(row({ position: 5 }))
      .mockResolvedValueOnce(
        row({ translations: [{ ...row().translations[0], slug: 'mens' }] }),
      );
    await svc.update('c1', { position: 5 }, ROOT);
    await svc.update(
      'c1',
      {
        translations: [{ localeCode: 'en-US', name: 'Men', slug: 'mens' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    expect(
      after.map(
        (e) =>
          (e as unknown as { data: { urlsChanged: boolean } }).data.urlsChanged,
      ),
    ).toEqual([false, true]);
    expect(prisma.categoryTranslation.deleteMany).toHaveBeenCalled();
    prisma.categoryTranslation.count.mockResolvedValue(0);
    await expect(
      svc.update('c1', { removeLocales: ['en-US'] }, ROOT),
    ).rejects.toThrow('at least one translation');
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(svc.update('x', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('moves a subtree in one statement and refuses cycles', async () => {
    const { svc, prisma, after } = setup();
    prisma.category.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'c1'
          ? row({ id: 'c1', path: 'a/c1', level: 1, parentId: 'a' })
          : where.id === 'b'
            ? { path: 'b', level: 0 }
            : where.id === 'kid'
              ? { path: 'a/c1/kid', level: 2 }
              : null,
    );
    prisma.$queryRaw.mockResolvedValue([{ depth: 3 }]);
    prisma.category.update.mockResolvedValue(
      row({ id: 'c1', parentId: 'b', path: 'b/c1' }),
    );
    await svc.move('c1', { parentId: 'b' }, ROOT);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(after[0]).toMatchObject({
      name: 'category.moved',
      data: { path: 'b/c1', urlsChanged: true },
    });
    await expect(svc.move('c1', { parentId: 'kid' }, ROOT)).rejects.toThrow(
      'own subtree',
    );
    await expect(svc.move('c1', { parentId: 'ghost' }, ROOT)).rejects.toThrow(
      'does not exist',
    );
    prisma.$queryRaw.mockResolvedValue([{ depth: 10 }]);
    await expect(svc.move('c1', { parentId: 'b' }, ROOT)).rejects.toThrow(
      'at most 10 levels',
    );
    await expect(
      svc.move('nope', { parentId: null }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes leaves only; list, tree and get', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.category.findUnique.mockResolvedValue({
      path: 'c1',
      _count: { children: 2 },
    });
    await expect(svc.remove('c1', ROOT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.category.findUnique.mockResolvedValue({
      path: 'c1',
      _count: { children: 0 },
    });
    await svc.remove('c1', ROOT);
    expect(afterNames()).toEqual(['category.deleted']);
    prisma.category.findUnique.mockResolvedValue(null);
    await expect(svc.remove('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
    prisma.category.findMany.mockResolvedValue([
      row(),
      row({ id: 'c2', parentId: 'c1', path: 'c1/c2', level: 1 }),
    ]);
    const tree = await svc.tree();
    expect(tree[0].children.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('CategoriesQuery', () => {
  it('collects ancestors, subtrees and visible localized categories', async () => {
    const prisma = fakePrisma();
    const q = new CategoriesQuery(prisma as never);
    expect(await q.withAncestors([])).toEqual(new Map());
    prisma.category.findMany
      .mockResolvedValueOnce([{ path: 'a/b' }])
      .mockResolvedValueOnce([
        { id: 'a', websites: [{ websiteId: 'w' }] },
        { id: 'b', websites: [] },
      ]);
    const nodes = await q.withAncestors(['b']);
    expect(prisma.category.findMany.mock.calls[1][0].where).toEqual({
      id: { in: ['a', 'b'] },
    });
    expect(nodes.get('a')?.websiteIds).toEqual(['w']);
    prisma.category.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await q.subtreeIds('a')).toEqual(['a', 'b']);
    const t = (localeCode: string, name: string) => ({
      localeCode,
      name,
      slug: name.toLowerCase(),
      description: null,
      metaTitle: null,
      metaDescription: null,
    });
    prisma.category.findMany.mockResolvedValueOnce([
      {
        id: 'a',
        parentId: null,
        level: 0,
        position: 0,
        includeInMenu: true,
        translations: [t('en-US', 'Men')],
      },
      {
        id: 'b',
        parentId: 'a',
        level: 1,
        position: 0,
        includeInMenu: true,
        translations: [t('vi-VN', 'Ao')],
      },
      {
        id: 'orphan',
        parentId: 'inactive',
        level: 1,
        position: 0,
        includeInMenu: true,
        translations: [t('en-US', 'X')],
      },
      {
        id: 'untranslated',
        parentId: null,
        level: 0,
        position: 1,
        includeInMenu: true,
        translations: [],
      },
    ]);
    const visible = await q.visible('w', ['vi-VN', 'en-US']);
    expect([...visible.keys()]).toEqual(['a', 'b']);
    expect(visible.get('b')?.name).toBe('Ao');
  });
});

describe('CategoryImageOwnerListener', () => {
  it('vetoes links to missing categories only', async () => {
    const prisma = fakePrisma();
    const l = new CategoryImageOwnerListener(prisma as never);
    const event = (ownerType: string, action = 'set') =>
      ({ action, input: { ownerType, ownerId: 'c1' } }) as never;
    await expect(l.onLinksWrite(event('CATEGORY'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await l.onLinksWrite(event('PRODUCT'));
    await l.onLinksWrite(event('CATEGORY', 'owner-removed'));
    prisma.category.count.mockResolvedValue(1);
    await l.onLinksWrite(event('CATEGORY'));
  });
});
