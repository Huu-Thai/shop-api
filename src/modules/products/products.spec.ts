import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import type { AttributeDef } from '../catalog/attribute-values.js';
import { AttributeUsageListener } from './attribute-usage.listener.js';
import { BundleOptionsWriter } from './bundle-options.writer.js';
import { ProductImageOwnerListener } from './image-owner.listener.js';
import { toProductDto } from './product.select.js';
import { effective, ProductsQuery } from './products.query.js';
import { ProductsService } from './products.service.js';
import { assertSkusFree } from './sku.js';
import { VariantsService } from './variants.service.js';

const def = (code: string, o: Partial<AttributeDef> = {}): AttributeDef => ({
  id: `id-${code}`,
  code,
  type: 'SELECT',
  isRequired: false,
  isLocalizable: false,
  isFilterable: true,
  isSearchable: false,
  isVisible: true,
  position: 0,
  options: ['red', 'blue', 's', 'm'].map((c, position) => ({
    code: c,
    swatch: null,
    position,
  })),
  ...o,
});
const DEFS = new Map(
  [
    def('color'),
    def('size'),
    def('material', { type: 'TEXT' }),
    def('care', { type: 'TEXTAREA', isLocalizable: true }),
  ].map((d) => [d.code, d]),
);

const productRow = (o: object = {}) => ({
  id: 'p1',
  sku: 'TEE',
  type: 'SIMPLE',
  status: 'ENABLED',
  visibility: 'CATALOG_SEARCH',
  attributeSetId: 'set',
  attributes: { material: 'Cotton' },
  typeOptions: {},
  weightGrams: 200,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  translations: [
    {
      localeCode: 'en-US',
      name: 'Tee',
      slug: 'tee',
      shortDescription: null,
      description: null,
      metaTitle: null,
      metaDescription: null,
      attributes: {},
    },
  ],
  websites: [{ websiteId: 'w1' }],
  categories: [],
  configurableAttributes: [],
  variants: [
    {
      id: 'v1',
      sku: 'TEE',
      optionValues: {},
      isDefault: true,
      status: 'ENABLED',
      weightGrams: 200,
      position: 0,
    },
  ],
  bundleOptions: [],
  storeOverrides: [],
  relations: [],
  ...o,
});

function setup() {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  const attributes = {
    setDefinitions: vi.fn(async () => DEFS),
    byIds: vi.fn(
      async () =>
        new Map([
          ['id-color', def('color')],
          ['id-size', def('size')],
        ]),
    ),
  };
  const bundles = { replace: vi.fn(async () => undefined) };
  const svc = new ProductsService(
    prisma as never,
    fb.bus,
    attributes as never,
    bundles as never,
  );
  prisma.attributeSet.findUnique.mockResolvedValue({ id: 'default-set' });
  prisma.product.findUnique.mockResolvedValue(productRow());
  prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());
  return { svc, prisma, attributes, bundles, ...fb };
}

describe('ProductsService.create', () => {
  it('creates a simple product with its default variant, slugs and validated attributes', async () => {
    const { svc, prisma, before, after } = setup();
    await svc.create(
      {
        sku: 'TEE',
        type: 'SIMPLE',
        attributes: { material: ' Cotton ', color: 'red' },
        weightGrams: 200,
        translations: [
          {
            localeCode: 'en-US',
            name: 'Classic Tee',
            attributes: { care: 'Cold wash' },
          },
        ],
        websiteIds: ['w1', 'w1'],
        categories: [{ categoryId: 'c1' }],
      },
      ROOT,
    );
    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      attributeSetId: 'default-set',
      attributes: { material: 'Cotton', color: 'red' },
      variants: { create: [{ sku: 'TEE', isDefault: true, weightGrams: 200 }] },
      websites: { create: [{ websiteId: 'w1' }] },
      categories: { create: [{ categoryId: 'c1', position: 0 }] },
      translations: {
        create: [
          expect.objectContaining({
            slug: 'classic-tee',
            attributes: { care: 'Cold wash' },
          }),
        ],
      },
    });
    expect(before[0]).toMatchObject({
      name: 'product.before-write',
      input: {
        sku: 'TEE',
        slugs: [{ localeCode: 'en-US', slug: 'classic-tee' }],
      },
    });
    expect(after[0]).toMatchObject({
      name: 'product.created',
      data: { urlsChanged: true },
    });
  });

  it('creates a configurable product with axes and variants', async () => {
    const { svc, prisma } = setup();
    await svc.create(
      {
        sku: 'TEE',
        type: 'CONFIGURABLE',
        translations: [{ localeCode: 'en-US', name: 'Tee' }],
        configurableAttributes: ['color', 'size'],
        variants: [
          { sku: 'TEE-R-S', options: { color: 'red', size: 's' } },
          { sku: 'TEE-B-M', options: { size: 'm', color: 'blue' } },
        ],
      },
      ROOT,
    );
    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data.configurableAttributes.create).toEqual([
      { attributeId: 'id-color', position: 0 },
      { attributeId: 'id-size', position: 1 },
    ]);
    expect(
      data.variants.create.map(
        (v: { optionSignature: string }) => v.optionSignature,
      ),
    ).toEqual(['color=red;size=s', 'color=blue;size=m']);
  });

  it('collects every validation problem in one 400', async () => {
    const { svc } = setup();
    const err = await svc
      .create(
        {
          sku: 'X',
          type: 'VIRTUAL',
          weightGrams: 5,
          typeOptions: { a: 1 },
          attributes: { color: 'pink' },
          configurableAttributes: ['color'],
          bundleOptions: [
            { code: 'x', inputType: 'RADIO', titles: [], selections: [] },
          ],
          translations: [
            { localeCode: 'en-US', name: 'X', attributes: { material: 'x' } },
          ],
        },
        ROOT,
      )
      .catch(
        (e: BadRequestException) => e.getResponse() as { message: string[] },
      );
    expect((err as { message: string[] }).message).toEqual(
      expect.arrayContaining([
        'VIRTUAL products have no typeOptions',
        'Virtual products have no weight',
        'Only CONFIGURABLE products have configurableAttributes and variants',
        'Only BUNDLE products have bundleOptions',
        expect.stringContaining('attributes.color must be one of'),
        'translations[en-US].attributes.material is not localizable; set it on the product',
      ]),
    );
  });

  it('rejects duplicate variant options and SKUs, unknown sets and duplicate categories', async () => {
    const { svc, attributes, prisma } = setup();
    const err = await svc
      .create(
        {
          sku: 'T',
          type: 'CONFIGURABLE',
          translations: [{ localeCode: 'en-US', name: 'T' }],
          configurableAttributes: ['color'],
          variants: [
            { sku: 'A', options: { color: 'red' } },
            { sku: 'A', options: { color: 'red' } },
          ],
        },
        ROOT,
      )
      .catch(
        (e: BadRequestException) =>
          (e.getResponse() as { message: string[] }).message,
      );
    expect(err).toEqual([
      'Two variants have the same options (color=red)',
      'Variant SKU A is used twice',
    ]);
    attributes.setDefinitions.mockResolvedValueOnce(undefined as never);
    await expect(
      svc.create(
        {
          sku: 'T',
          type: 'SIMPLE',
          attributeSetId: 'nope',
          translations: [{ localeCode: 'en-US', name: 'T' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('does not exist');
    await expect(
      svc.create(
        {
          sku: 'T',
          type: 'SIMPLE',
          translations: [{ localeCode: 'en-US', name: 'T' }],
          categories: [{ categoryId: 'c' }, { categoryId: 'c' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('twice');
    prisma.attributeSet.findUnique.mockResolvedValue(null);
    await expect(
      svc.create(
        {
          sku: 'T',
          type: 'SIMPLE',
          translations: [{ localeCode: 'en-US', name: 'T' }],
        },
        ROOT,
      ),
    ).rejects.toThrow('attributeSetId is required');
  });

  it('writes bundle options in the same transaction', async () => {
    const { svc, bundles } = setup();
    const options = [
      {
        code: 'top',
        inputType: 'RADIO' as const,
        titles: [{ localeCode: 'en-US', title: 'Top' }],
        selections: [{ variantId: 'v' }],
      },
    ];
    await svc.create(
      {
        sku: 'B',
        type: 'BUNDLE',
        translations: [{ localeCode: 'en-US', name: 'B' }],
        bundleOptions: options,
      },
      ROOT,
    );
    expect(bundles.replace).toHaveBeenCalledWith(
      expect.anything(),
      'new-id',
      options,
    );
  });

  it('refuses SKUs already used by another product or variant', async () => {
    const { svc, prisma } = setup();
    prisma.productVariant.findMany.mockResolvedValue([{ sku: 'TEE' }]);
    await expect(
      svc.create(
        {
          sku: 'TEE',
          type: 'SIMPLE',
          translations: [{ localeCode: 'en-US', name: 'T' }],
        },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ProductsService.update / delete / overrides / relations', () => {
  it('merge-patches attributes, keeps the default variant in step and flags URL changes', async () => {
    const { svc, prisma, after } = setup();
    prisma.productTranslation.count.mockResolvedValue(1);
    prisma.product.findUniqueOrThrow.mockResolvedValue(
      productRow({
        sku: 'TEE2',
        attributes: { color: 'red' },
        translations: [{ ...productRow().translations[0], slug: 'tee-2' }],
      }),
    );
    await svc.update(
      'p1',
      {
        sku: 'TEE2',
        attributes: { material: null, color: 'red' },
        translations: [{ localeCode: 'en-US', name: 'Tee', slug: 'tee-2' }],
      },
      ROOT,
    );
    expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({
      sku: 'TEE2',
      attributes: { color: 'red' },
    });
    expect(prisma.productVariant.updateMany).toHaveBeenCalledWith({
      where: { productId: 'p1', isDefault: true },
      data: { sku: 'TEE2', weightGrams: 200 },
    });
    expect(after[0]).toMatchObject({
      name: 'product.updated',
      data: { urlsChanged: true },
    });
  });

  it('refuses updates to deleted or missing products and empty translation sets', async () => {
    const { svc, prisma } = setup();
    prisma.product.findUnique.mockResolvedValueOnce(
      productRow({ deletedAt: new Date() }),
    );
    await expect(svc.update('p1', {}, ROOT)).rejects.toThrow(
      'restore it first',
    );
    prisma.product.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('p1', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.update('p1', { removeLocales: ['en-US'] }, ROOT),
    ).rejects.toThrow('at least one translation');
  });

  it('re-validates translations when the attribute set changes and type options on update', async () => {
    const { svc, prisma, attributes } = setup();
    prisma.product.findUnique.mockResolvedValue(
      productRow({
        translations: [
          { ...productRow().translations[0], attributes: { care: 'x' } },
        ],
      }),
    );
    attributes.setDefinitions.mockResolvedValue(
      new Map([def('material', { type: 'TEXT' })].map((d) => [d.code, d])),
    );
    const err = await svc
      .update('p1', { attributeSetId: 'other' }, ROOT)
      .catch(
        (e: BadRequestException) =>
          (e.getResponse() as { message: string[] }).message,
      );
    expect(err).toEqual([
      "translations[en-US].attributes.care is not in the product's attribute set",
    ]);
    attributes.setDefinitions.mockResolvedValue(DEFS);
    await expect(
      svc.update('p1', { typeOptions: { x: 1 } }, ROOT),
    ).rejects.toThrow();
  });

  it('soft-deletes and restores idempotently', async () => {
    const { svc, prisma, afterNames } = setup();
    await svc.remove('p1', ROOT);
    prisma.product.findUnique.mockResolvedValue(
      productRow({ deletedAt: new Date() }),
    );
    await svc.remove('p1', ROOT);
    await svc.restore('p1', ROOT);
    expect(afterNames()).toEqual(['product.deleted', 'product.restored']);
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(svc.remove('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.restore('x', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('store overrides: validated patch, removed when empty', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.product.findUnique.mockResolvedValue({
      attributeSetId: 'set',
      configurableAttributes: [{ attribute: { code: 'color' } }],
    });
    await expect(
      svc.setStoreOverride('p1', 's1', { attributes: { color: 'red' } }, ROOT),
    ).rejects.toMatchObject({
      response: { message: [expect.stringContaining('variant option')] },
    });
    expect(
      await svc.setStoreOverride(
        'p1',
        's1',
        { status: 'DISABLED', attributes: { material: 'Wool' } },
        ROOT,
      ),
    ).toEqual({
      storeId: 's1',
      status: 'DISABLED',
      visibility: null,
      attributes: { material: 'Wool' },
    });
    prisma.productStoreOverride.findUnique.mockResolvedValue({
      status: 'DISABLED',
      visibility: null,
      attributes: {},
    });
    expect(
      await svc.setStoreOverride('p1', 's1', { status: null }, ROOT),
    ).toBeNull();
    expect(prisma.productStoreOverride.deleteMany).toHaveBeenCalled();
    expect(afterNames()).toEqual([
      'product.store-override-changed',
      'product.store-override-changed',
    ]);
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(
      svc.setStoreOverride('x', 's1', {}, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('relations: no self, no duplicates, existing products only', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.setRelations('p1', { related: ['p1'] }, ROOT),
    ).rejects.toThrow('itself');
    await expect(
      svc.setRelations('p1', { upsell: ['a', 'a'] }, ROOT),
    ).rejects.toThrow('twice');
    await expect(
      svc.setRelations('p1', { related: ['p2'] }, ROOT),
    ).rejects.toThrow('Products not found');
    prisma.product.findMany.mockResolvedValue([
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
    ]);
    await svc.setRelations('p1', { related: ['p2'], crossSell: ['p3'] }, ROOT);
    expect(prisma.productRelation.createMany).toHaveBeenCalledWith({
      data: [
        {
          productId: 'p1',
          relatedProductId: 'p2',
          type: 'RELATED',
          position: 0,
        },
        {
          productId: 'p1',
          relatedProductId: 'p3',
          type: 'CROSSSELL',
          position: 0,
        },
      ],
    });
  });

  it('lists with filters and a name in the requested locale; maps the admin DTO', async () => {
    const { svc, prisma } = setup();
    prisma.product.findMany.mockResolvedValue([
      {
        id: 'p1',
        sku: 'TEE',
        type: 'SIMPLE',
        status: 'ENABLED',
        visibility: 'CATALOG',
        updatedAt: new Date(),
        deletedAt: null,
        translations: [
          { localeCode: 'en-US', name: 'Tee' },
          { localeCode: 'vi-VN', name: 'Áo' },
        ],
        _count: { variants: 1 },
      },
    ]);
    prisma.product.count.mockResolvedValue(1);
    const page = await svc.list({
      page: 1,
      limit: 10,
      skip: 0,
      order: 'desc',
      search: 'tee',
      websiteId: 'w',
      categoryId: 'c',
      locale: 'vi-VN',
    } as never);
    expect(page.data[0]).toMatchObject({ name: 'Áo', variantCount: 1 });
    expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      websites: { some: { websiteId: 'w' } },
    });
    const dto = toProductDto(
      productRow({
        relations: [{ relatedProductId: 'x', type: 'UPSELL' }],
        bundleOptions: [
          {
            id: 'o',
            code: 'top',
            inputType: 'RADIO',
            isRequired: true,
            position: 0,
            translations: [],
            selections: [
              {
                id: 's',
                variantId: 'v',
                qty: 1,
                canChangeQty: false,
                isDefault: true,
                position: 0,
                variant: { sku: 'V' },
              },
            ],
          },
        ],
      }) as never,
    );
    expect(dto.relations.upsell).toEqual(['x']);
    expect(dto.bundleOptions[0].selections[0].variantSku).toBe('V');
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('VariantsService', () => {
  function vsetup(type = 'CONFIGURABLE') {
    const base = setup();
    base.prisma.product.findUnique.mockResolvedValue({
      type,
      deletedAt: null,
      configurableAttributes: [
        { attributeId: 'id-color' },
        { attributeId: 'id-size' },
      ],
    });
    const variants = new VariantsService(
      base.prisma as never,
      base.bus,
      base.attributes as never,
      base.bundles as never,
      base.svc,
    );
    return { ...base, variants };
  }
  const v = {
    id: 'v2',
    sku: 'TEE-B-M',
    optionValues: { color: 'blue', size: 'm' },
    isDefault: false,
    status: 'ENABLED',
    weightGrams: null,
    position: 1,
  };

  it('adds, edits and deletes configurable variants', async () => {
    const { variants, prisma, afterNames } = vsetup();
    prisma.productVariant.create.mockResolvedValue(v);
    expect(
      await variants.create(
        'p1',
        { sku: 'TEE-B-M', options: { color: 'blue', size: 'm' } },
        ROOT,
      ),
    ).toEqual(v);
    expect(
      prisma.productVariant.create.mock.calls[0][0].data.optionSignature,
    ).toBe('color=blue;size=m');
    await expect(
      variants.create('p1', { sku: 'X', options: { color: 'blue' } }, ROOT),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.productVariant.findFirst.mockResolvedValue(v);
    prisma.productVariant.update.mockResolvedValue({
      ...v,
      status: 'DISABLED',
    });
    await variants.update('p1', 'v2', { status: 'DISABLED' }, ROOT);
    prisma.productVariant.findFirst.mockResolvedValue({ sku: 'TEE-B-M' });
    await variants.remove('p1', 'v2', ROOT);
    expect(afterNames()).toEqual([
      'product.variant-created',
      'product.variant-updated',
      'product.variant-deleted',
    ]);
  });

  it('protects variants sold in bundles and non-configurable products', async () => {
    const { variants, prisma } = vsetup();
    prisma.productVariant.findFirst.mockResolvedValue({ sku: 'TEE-B-M' });
    prisma.bundleSelection.count.mockResolvedValue(1);
    await expect(variants.remove('p1', 'v2', ROOT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.productVariant.findFirst.mockResolvedValue(null);
    await expect(
      variants.update('p1', 'nope', {}, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(variants.remove('p1', 'nope', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const simple = vsetup('SIMPLE');
    await expect(
      simple.variants.create('p1', { sku: 'X', options: {} }, ROOT),
    ).rejects.toThrow('Only CONFIGURABLE');
    simple.prisma.product.findUnique.mockResolvedValue(null);
    await expect(
      simple.variants.create('p1', { sku: 'X', options: {} }, ROOT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replaces bundle options of bundles only', async () => {
    const b = vsetup('BUNDLE');
    b.prisma.product.findUnique
      .mockResolvedValueOnce({ type: 'BUNDLE', deletedAt: null })
      .mockResolvedValueOnce(productRow({ type: 'BUNDLE' }));
    await b.variants.setBundleOptions('p1', { options: [] }, ROOT);
    expect(b.bundles.replace).toHaveBeenCalled();
    expect(b.afterNames()).toEqual(['product.bundle-changed']);
    const c = vsetup('SIMPLE');
    await expect(
      c.variants.setBundleOptions('p1', { options: [] }, ROOT),
    ).rejects.toThrow('Only BUNDLE');
  });
});

describe('BundleOptionsWriter', () => {
  const opt = (
    selections: { variantId: string; isDefault?: boolean }[],
    code = 'top',
  ) => ({
    code,
    inputType: 'RADIO' as const,
    titles: [{ localeCode: 'en-US', title: 'T' }],
    selections,
  });

  it('validates selections against the catalog and writes options', async () => {
    const tx = fakePrisma();
    tx.productVariant.findMany.mockResolvedValue([
      {
        id: 'v1',
        sku: 'TEE-R',
        product: { id: 'tee', type: 'CONFIGURABLE', deletedAt: null },
      },
      {
        id: 'v2',
        sku: 'GC',
        product: { id: 'gc', type: 'GIFT_CARD', deletedAt: null },
      },
      {
        id: 'v3',
        sku: 'SELF',
        product: { id: 'bundle', type: 'BUNDLE', deletedAt: null },
      },
    ]);
    const w = new BundleOptionsWriter();
    const err = await w
      .replace(tx as never, 'bundle', [
        opt([{ variantId: 'v2' }, { variantId: 'v3' }, { variantId: 'gone' }]),
        opt([], 'top'),
      ])
      .catch(
        (e: BadRequestException) =>
          (e.getResponse() as { message: string[] }).message,
      );
    expect(err).toEqual([
      'Duplicate bundle option code',
      'bundleOptions[top] needs at least one selection',
      'Variant GC belongs to a GIFT_CARD product, which cannot be bundled',
      'A bundle cannot contain itself',
      'Variant gone does not exist',
    ]);
    await w.replace(tx as never, 'bundle', [
      opt([{ variantId: 'v1', isDefault: true }]),
    ]);
    expect(tx.bundleOption.deleteMany).toHaveBeenCalledWith({
      where: { productId: 'bundle' },
    });
    expect(tx.bundleOption.create.mock.calls[0][0].data).toMatchObject({
      code: 'top',
      isRequired: true,
      selections: {
        create: [{ variantId: 'v1', qty: 1, isDefault: true, position: 0 }],
      },
    });
  });
});

describe('cross-module listeners', () => {
  it('vetoes deleting attributes or options in use', async () => {
    const prisma = fakePrisma();
    const l = new AttributeUsageListener(prisma as never);
    const ev = (action: string, removed: string[] = []) =>
      ({
        action,
        input: { code: 'color', removedOptionCodes: removed },
      }) as never;
    await l.onAttributeWrite(ev('create'));
    await l.onAttributeWrite(ev('update'));
    prisma.$queryRaw.mockResolvedValue([{ n: 3 }]);
    await expect(l.onAttributeWrite(ev('delete'))).rejects.toThrow(
      'used by 3 product(s)',
    );
    await expect(l.onAttributeWrite(ev('update', ['red']))).rejects.toThrow(
      'Options red of color',
    );
    prisma.$queryRaw.mockResolvedValue([{ n: 0 }]);
    await l.onAttributeWrite(ev('delete'));
  });

  it('vetoes image links to missing products and variants', async () => {
    const prisma = fakePrisma();
    const l = new ProductImageOwnerListener(prisma as never);
    const ev = (ownerType: string, action = 'set') =>
      ({ action, input: { ownerType, ownerId: 'x' } }) as never;
    await expect(l.onLinksWrite(ev('PRODUCT'))).rejects.toThrow(
      'Product x not found',
    );
    await expect(l.onLinksWrite(ev('VARIANT'))).rejects.toThrow(
      'Variant x not found',
    );
    await l.onLinksWrite(ev('CATEGORY'));
    await l.onLinksWrite(ev('PRODUCT', 'owner-removed'));
    prisma.product.count.mockResolvedValue(1);
    await l.onLinksWrite(ev('PRODUCT'));
  });

  it('assertSkusFree ignores the owner and empty input', async () => {
    const tx = fakePrisma();
    await assertSkusFree(tx as never, []);
    await assertSkusFree(tx as never, ['A'], 'p1');
    expect(tx.product.findMany.mock.calls[0][0].where).toEqual({
      sku: { in: ['A'] },
      id: { not: 'p1' },
    });
  });
});

describe('ProductsQuery', () => {
  const ctx = {
    storeId: 's',
    storeCode: 'us',
    websiteId: 'w',
    websiteCode: 'us',
    localeCode: 'vi-VN',
    localeChain: ['vi-VN', 'en-US'],
    currencyCode: 'USD',
    countryCode: 'US',
    pricesIncludeTax: false,
  };

  it('applies store overrides to status and visibility', () => {
    expect(
      effective(
        { status: 'ENABLED', visibility: 'CATALOG' },
        { status: 'DISABLED', visibility: null },
      ),
    ).toEqual({ status: 'DISABLED', visibility: 'CATALOG' });
    expect(effective({ status: 'ENABLED', visibility: 'CATALOG' })).toEqual({
      status: 'ENABLED',
      visibility: 'CATALOG',
    });
  });

  it('listing builds one SQL statement and returns ids with the total', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([
      { id: 'a', total: 2n },
      { id: 'b', total: 2n },
    ]);
    const q = new ProductsQuery(prisma as never);
    for (const sort of ['position', 'name', 'newest'] as const)
      expect(
        await q.listing(ctx, {
          categoryIds: ['c'],
          filters: sort === 'name' ? { color: ['red'] } : {},
          sort,
          page: 2,
          limit: 10,
        }),
      ).toEqual({ ids: ['a', 'b'], total: 2 });
    const sql = prisma.$queryRaw.mock.calls[1][0];
    expect((sql as string[]).join('?')).toContain('COLLATE "und-x-icu"');
    prisma.$queryRaw.mockResolvedValue([]);
    expect(
      await q.listing(ctx, {
        categoryIds: ['c'],
        filters: {},
        sort: 'position',
        page: 1,
        limit: 10,
      }),
    ).toEqual({ ids: [], total: 0 });
  });

  it('tells which products exist (not deleted)', async () => {
    const prisma = fakePrisma();
    const q = new ProductsQuery(prisma as never);
    expect(await q.existing([])).toEqual(new Set());
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'a' }]);
    expect(await q.existing(['a', 'b'])).toEqual(new Set(['a']));
    expect(prisma.product.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it('filters visibility, picks translations and resolves slugs', async () => {
    const prisma = fakePrisma();
    const q = new ProductsQuery(prisma as never);
    expect(await q.visibleIds(ctx, [])).toEqual([]);
    prisma.product.findMany.mockResolvedValueOnce([
      { id: 'a', status: 'ENABLED', visibility: 'SEARCH', storeOverrides: [] },
      {
        id: 'b',
        status: 'ENABLED',
        visibility: 'CATALOG',
        storeOverrides: [{ status: 'DISABLED', visibility: null }],
      },
      {
        id: 'c',
        status: 'DISABLED',
        visibility: 'CATALOG',
        storeOverrides: [{ status: 'ENABLED', visibility: null }],
      },
    ]);
    expect(await q.visibleIds(ctx, ['c', 'b', 'a'])).toEqual(['c', 'a']);
    prisma.product.findMany.mockResolvedValueOnce([
      { id: 'a', status: 'ENABLED', visibility: 'SEARCH', storeOverrides: [] },
    ]);
    expect(await q.visibleIds(ctx, ['a'], true)).toEqual([]);
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: 'a',
        sku: 'A',
        type: 'SIMPLE',
        translations: [
          { localeCode: 'en-US', name: 'A', slug: 'a', shortDescription: null },
        ],
      },
      { id: 'b', sku: 'B', type: 'SIMPLE', translations: [] },
    ]);
    expect(await q.summaries(ctx, ['b', 'a', 'zz'])).toEqual([
      {
        id: 'a',
        sku: 'A',
        type: 'SIMPLE',
        name: 'A',
        slug: 'a',
        shortDescription: null,
      },
    ]);
    expect(await q.summaries(ctx, [])).toEqual([]);
    prisma.productTranslation.findMany.mockResolvedValue([
      { productId: 'en', localeCode: 'en-US' },
      { productId: 'vi', localeCode: 'vi-VN' },
    ]);
    expect(await q.idBySlug(ctx, 'tee')).toBe('vi');
    prisma.product.findMany.mockResolvedValueOnce([{ id: 'p' }]);
    expect(await q.idsOnWebsite('w')).toEqual(['p']);
    await q.urlData('p');
  });

  it('view composes the product for one store (overrides, sellable bundle parts, visible relations)', async () => {
    const prisma = fakePrisma();
    const q = new ProductsQuery(prisma as never);
    prisma.product.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id,
          status: id === 'hidden' ? 'DISABLED' : 'ENABLED',
          visibility: 'CATALOG_SEARCH',
          storeOverrides: [],
        })),
    );
    prisma.product.findUnique.mockResolvedValue({
      id: 'p',
      sku: 'P',
      type: 'BUNDLE',
      attributeSetId: 'set',
      attributes: { a: 1, b: 1 },
      typeOptions: { priceType: 'DYNAMIC' },
      weightGrams: null,
      translations: [
        {
          localeCode: 'en-US',
          name: 'P',
          slug: 'p',
          shortDescription: null,
          description: null,
          metaTitle: null,
          metaDescription: null,
          attributes: { care: 'x' },
        },
      ],
      storeOverrides: [{ attributes: { b: 2 } }],
      configurableAttributes: [],
      variants: [
        {
          id: 'v',
          sku: 'P',
          optionValues: {},
          isDefault: true,
          weightGrams: null,
        },
      ],
      bundleOptions: [
        {
          code: 'top',
          inputType: 'RADIO',
          isRequired: true,
          translations: [],
          selections: [
            {
              variantId: 'v1',
              qty: 1,
              canChangeQty: false,
              isDefault: true,
              variant: { sku: 'T', status: 'ENABLED', productId: 'tee' },
            },
            {
              variantId: 'v2',
              qty: 1,
              canChangeQty: false,
              isDefault: false,
              variant: { sku: 'H', status: 'ENABLED', productId: 'hidden' },
            },
          ],
        },
        {
          code: 'gone',
          inputType: 'RADIO',
          isRequired: false,
          translations: [],
          selections: [
            {
              variantId: 'v3',
              qty: 1,
              canChangeQty: false,
              isDefault: false,
              variant: { sku: 'X', status: 'DISABLED', productId: 'tee' },
            },
          ],
        },
      ],
      categories: [{ categoryId: 'c' }],
      relations: [
        { relatedProductId: 'r1', type: 'RELATED' },
        { relatedProductId: 'hidden', type: 'UPSELL' },
      ],
    });
    const v = await q.view(ctx, 'p');
    expect(v).toMatchObject({
      localeCode: 'en-US',
      attributes: { a: 1, b: 2, care: 'x' },
      relations: { related: ['r1'], upsell: [], crossSell: [] },
    });
    expect(v!.bundleOptions).toEqual([
      {
        code: 'top',
        inputType: 'RADIO',
        isRequired: true,
        title: 'top',
        selections: [expect.objectContaining({ variantId: 'v1', sku: 'T' })],
      },
    ]);
    expect(await q.view(ctx, 'hidden')).toBeUndefined();
  });
});
