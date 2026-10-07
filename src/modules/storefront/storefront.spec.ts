import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { LocalizedAttribute } from '../catalog/attributes.query.js';
import type { CategoryProductsQueryDto } from './dto/storefront.dto.js';
import {
  cardImage,
  parseFilters,
  StorefrontCatalogService,
  valueLabel,
} from './storefront-catalog.service.js';
import {
  StorefrontCategoriesController,
  StorefrontProductsController,
  StorefrontUrlController,
} from './storefront.controllers.js';

const ctx = {
  storeId: 's',
  storeCode: 'vn',
  websiteId: 'w',
  websiteCode: 'vn',
  localeCode: 'vi-VN',
  localeChain: ['vi-VN', 'en-US'],
  currencyCode: 'VND',
  countryCode: 'VN',
  pricesIncludeTax: true,
};
const img = (role: string, id = role) =>
  ({
    id,
    role,
    position: 0,
    url: `u/${id}`,
    width: 10,
    height: 10,
    alt: null,
    renditions: [],
  }) as never;
const cat = (id: string, parentId: string | null, name: string) => ({
  id,
  parentId,
  level: parentId ? 1 : 0,
  position: 0,
  includeInMenu: true,
  name,
  slug: name.toLowerCase(),
  description: null,
  metaTitle: null,
  metaDescription: null,
});
const attr = (
  code: string,
  type: string,
  options: Record<string, string> = {},
): LocalizedAttribute => ({
  def: {
    id: code,
    code,
    type,
    isRequired: false,
    isLocalizable: false,
    isFilterable: true,
    isSearchable: false,
    isVisible: true,
    position: 0,
    options: [],
  } as never,
  label: code.toUpperCase(),
  options: new Map(
    Object.entries(options).map(([c, label], position) => [
      c,
      { label, swatch: null, position },
    ]),
  ),
});

describe('helpers', () => {
  it('picks the card image by role', () => {
    expect(cardImage([img('GALLERY'), img('BASE'), img('SMALL')])?.role).toBe(
      'SMALL',
    );
    expect(cardImage([img('GALLERY'), img('BASE')])?.role).toBe('BASE');
    expect(cardImage([img('GALLERY')])?.role).toBe('GALLERY');
    expect(cardImage()).toBeNull();
  });
  it('labels values and parses filters', () => {
    expect(valueLabel(attr('color', 'SELECT', { red: 'Đỏ' }), 'red')).toBe(
      'Đỏ',
    );
    expect(
      valueLabel(attr('tags', 'MULTISELECT', { a: 'A' }), ['a', 'b']),
    ).toBe('A, b');
    expect(valueLabel(attr('eco', 'BOOLEAN'), false)).toBe('No');
    expect(valueLabel(attr('n', 'INTEGER'), 3)).toBe('3');
    expect(parseFilters(['color:red,blue', 'color:red', 'size:m'])).toEqual({
      color: ['red', 'blue'],
      size: ['m'],
    });
    expect(parseFilters()).toEqual({});
  });
});

function setup() {
  const visible = new Map(
    [cat('men', null, 'Nam'), cat('tees', 'men', 'Ao')].map((c) => [c.id, c]),
  );
  const categories = { visible: vi.fn(async () => visible) };
  const products = {
    listing: vi.fn(async (_c: unknown, _q: unknown) => ({
      ids: ['p1'],
      total: 1,
    })),
    summaries: vi.fn(async (_c: unknown, ids: string[]) =>
      ids.map((id) => ({
        id,
        sku: id.toUpperCase(),
        type: 'SIMPLE',
        name: `N-${id}`,
        slug: id,
        shortDescription: null,
      })),
    ),
    idBySlug: vi.fn(async (_c: unknown, slug: string) =>
      slug === 'tee' ? 'p1' : undefined,
    ),
    view: vi.fn(),
    sellableUnits: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [id, { type: 'SIMPLE', variantIds: [`v-${id}`] }]),
        ),
    ),
    visibleIds: vi.fn(async (_c: unknown, ids: string[]) => ids),
  };
  const priceOf = (amount: number) => ({
    currency: 'VND',
    amount,
    net: amount,
    gross: amount,
    includesTax: true,
    taxRate: '10.0000',
    formatted: `${amount} ₫`,
    compareAt: null,
    compareAtFormatted: null,
    tiers: [],
    converted: false,
  });
  const pricing = {
    prices: vi.fn(
      async (_c: unknown, ids: string[]) =>
        new Map(
          ids
            .filter((id) => !id.includes('unpriced'))
            .map((id) => [id, priceOf(id.includes('cheap') ? 100 : 500)]),
        ),
    ),
    formatter: vi.fn(async () => (a: number, c: string) => `${a} ${c}`),
  };
  const inventory = {
    salable: vi.fn(
      async (_w: string, ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              managed: true,
              salable: id.includes('oos') ? 0 : 5,
              inStock: !id.includes('oos'),
            },
          ]),
        ),
    ),
  };
  const attributes = {
    byCodes: vi.fn(
      async (codes: string[]) =>
        new Map(codes.map((c) => [c, { isFilterable: c !== 'material' }])),
    ),
    byIds: vi.fn(async () => new Map([['a-color', { code: 'color' }]])),
    setDefinitions: vi.fn(
      async () =>
        new Map([
          ['material', { isVisible: true }],
          ['secret', { isVisible: false }],
          ['color', { isVisible: true }],
        ]),
    ),
    localized: vi.fn(
      async () =>
        new Map([
          ['material', attr('material', 'TEXT')],
          [
            'color',
            attr('color', 'SELECT', { red: 'Đỏ', blue: 'Xanh', green: 'Lá' }),
          ],
        ]),
    ),
  };
  const media = {
    imagesFor: vi.fn(
      async (_t: string, ids: string[]) =>
        new Map(ids.map((id) => [id, [img('BASE', id)]])),
    ),
  };
  const urls = {
    canonicalPaths: vi.fn(
      async (_c: unknown, _t: string, ids: string[]) =>
        new Map(ids.map((id) => [id, `path/${id}`])),
    ),
    resolve: vi.fn(async (_c: unknown, p: string) =>
      p === '/tee'
        ? {
            type: 'PRODUCT',
            id: 'p1',
            canonicalPath: 'tee',
            redirectStatus: null,
            location: null,
          }
        : p === '/about' || p === '/blog/soon'
          ? {
              type: p === '/about' ? 'CMS_PAGE' : 'CMS_POST',
              id: p === '/about' ? 'pg1' : 'po1',
              canonicalPath: p.slice(1),
              redirectStatus: null,
              location: null,
            }
          : undefined,
    ),
  };
  const cms = {
    visibleTitles: vi.fn(
      async (_c: unknown, _k: string, ids: string[]) =>
        new Map(ids.filter((i) => i === 'pg1').map((i) => [i, 'About'])),
    ),
  };
  // An in-memory stand-in for the Redis read-model cache.
  const store = new Map<string, unknown>();
  const cache = {
    getModels: vi.fn(async (keys: string[]) => ({
      values: keys.map((k) => store.get(k)),
      version: '1',
    })),
    setModels: vi.fn(async (entries: { key: string; value: unknown }[]) => {
      for (const e of entries) store.set(e.key, e.value);
    }),
    clear: () => store.clear(),
  };
  const svc = new StorefrontCatalogService(
    categories as never,
    products as never,
    attributes as never,
    media as never,
    urls as never,
    pricing as never,
    inventory as never,
    cms as never,
    cache as never,
  );
  return {
    svc,
    cache,
    categories,
    products,
    attributes,
    media,
    urls,
    pricing,
    inventory,
  };
}

describe('StorefrontCatalogService', () => {
  it('category tree and single category with URLs and images', async () => {
    const { svc } = setup();
    const tree = await svc.categoryTree(ctx);
    expect(tree[0]).toMatchObject({
      id: 'men',
      urlPath: 'path/men',
      image: { role: 'BASE' },
      children: [{ id: 'tees', name: 'Ao' }],
    });
    expect((await svc.category(ctx, 'tees')).urlPath).toBe('path/tees');
    await expect(svc.category(ctx, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('category listing: subtree, validated filters, cards', async () => {
    const { svc, products } = setup();
    const q = {
      page: 1,
      limit: 24,
      sort: 'position',
      includeSubcategories: true,
      filter: ['color:red'],
    } as CategoryProductsQueryDto;
    const out = await svc.categoryProducts(ctx, 'men', { ...q });
    expect(products.listing).toHaveBeenCalledWith(ctx, {
      categoryIds: ['men', 'tees'],
      filters: { color: ['red'] },
      sort: 'position',
      page: 1,
      limit: 24,
    });
    expect(out).toEqual({
      data: [
        {
          id: 'p1',
          sku: 'P1',
          type: 'SIMPLE',
          name: 'N-p1',
          slug: 'p1',
          shortDescription: null,
          urlPath: 'path/p1',
          image: expect.objectContaining({ role: 'BASE' }),
          price: expect.objectContaining({ amount: 500 }),
          inStock: true,
        },
      ],
      total: 1,
      page: 1,
      limit: 24,
    });
    await svc.categoryProducts(ctx, 'men', {
      ...q,
      includeSubcategories: false,
      filter: undefined,
    });
    expect(products.listing.mock.calls[1][1]).toMatchObject({
      categoryIds: ['men'],
      filters: {},
    });
    await expect(
      svc.categoryProducts(ctx, 'men', { ...q, filter: ['material:x'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.categoryProducts(ctx, 'nope', { ...q }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('product page: visible attributes, option matrix, breadcrumbs, related cards', async () => {
    const { svc, products, inventory, cache } = setup();
    products.view.mockResolvedValue({
      id: 'p1',
      sku: 'TEE',
      type: 'CONFIGURABLE',
      name: 'Áo',
      slug: 'ao',
      shortDescription: null,
      description: '<p>x</p>',
      metaTitle: null,
      metaDescription: null,
      localeCode: 'vi-VN',
      attributeSetId: 'set',
      attributes: { material: 'Cotton', secret: 'x' },
      typeOptions: {},
      weightGrams: 200,
      configurableAttributeIds: ['a-color'],
      variants: [
        {
          id: 'v1',
          sku: 'TEE-B',
          optionValues: { color: 'blue' },
          isDefault: false,
          weightGrams: null,
        },
        {
          id: 'v2',
          sku: 'TEE-R',
          optionValues: { color: 'red' },
          isDefault: false,
          weightGrams: null,
        },
      ],
      bundleOptions: [],
      categoryIds: ['ghost', 'tees'],
      relations: { related: ['r1'], upsell: [], crossSell: [] },
    });
    const p = await svc.productBySlug(ctx, 'tee');
    expect(p).toMatchObject({
      id: 'p1',
      urlPath: 'path/p1',
      locale: 'vi-VN',
      bundle: null,
      giftCard: null,
    });
    expect(p.attributes).toEqual([
      {
        code: 'material',
        label: 'MATERIAL',
        value: 'Cotton',
        valueLabel: 'Cotton',
      },
    ]);
    expect(p.configurableOptions).toEqual([
      {
        code: 'color',
        label: 'COLOR',
        values: [
          { code: 'red', label: 'Đỏ', swatch: null },
          { code: 'blue', label: 'Xanh', swatch: null },
        ],
      },
    ]);
    expect(p.breadcrumbs).toEqual([
      { id: 'men', name: 'Nam', urlPath: 'path/men' },
      { id: 'tees', name: 'Ao', urlPath: 'path/tees' },
    ]);
    expect(p.variants[0].images).toHaveLength(1);
    expect(p.related.map((c) => c.id)).toEqual(['r1']);
    expect(p.variants[0].stock.salable).toBe(5);

    // Again: the catalog part comes from the cache, prices and stock are read now.
    inventory.salable.mockImplementationOnce(
      async (_w: string, ids: string[]) =>
        new Map(
          ids.map((id) => [id, { managed: true, salable: 1, inStock: true }]),
        ),
    );
    const again = await svc.productBySlug(ctx, 'tee');
    expect(products.view).toHaveBeenCalledTimes(1);
    expect(products.idBySlug).toHaveBeenCalledTimes(1);
    expect(again.variants[0].stock.salable).toBe(1);
    expect(again.attributes).toEqual(p.attributes);
    expect(cache.setModels).toHaveBeenCalled();
    await expect(svc.productBySlug(ctx, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    products.view.mockResolvedValue(undefined);
    await expect(svc.product(ctx, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('bundles name their selections; gift cards show amounts in the request currency', async () => {
    const { svc, products } = setup();
    const base = {
      sku: 'X',
      name: 'X',
      slug: 'x',
      shortDescription: null,
      description: null,
      metaTitle: null,
      metaDescription: null,
      localeCode: 'vi-VN',
      attributeSetId: 's',
      attributes: {},
      weightGrams: null,
      configurableAttributeIds: [],
      variants: [],
      categoryIds: [],
      relations: { related: [], upsell: [], crossSell: [] },
    };
    products.view.mockResolvedValueOnce({
      ...base,
      id: 'b',
      type: 'BUNDLE',
      typeOptions: { priceType: 'FIXED', shipmentType: 'TOGETHER' },
      bundleOptions: [
        {
          code: 'top',
          inputType: 'RADIO',
          isRequired: true,
          title: 'Top',
          selections: [
            {
              variantId: 'v',
              productId: 'tee',
              sku: 'TEE-R',
              qty: 1,
              canChangeQty: false,
              isDefault: true,
            },
          ],
        },
      ],
    });
    const b = await svc.product(ctx, 'b');
    expect(b.bundle).toEqual({
      priceType: 'FIXED',
      shipmentType: 'TOGETHER',
      options: [
        {
          code: 'top',
          inputType: 'RADIO',
          isRequired: true,
          title: 'Top',
          selections: [expect.objectContaining({ name: 'N-tee' })],
        },
      ],
    });
    products.view.mockResolvedValueOnce({
      ...base,
      id: 'g',
      type: 'GIFT_CARD',
      bundleOptions: [],
      typeOptions: {
        cardType: 'VIRTUAL',
        amounts: [
          { currency: 'USD', amount: 2500 },
          { currency: 'VND', amount: 500000 },
        ],
        allowOpenAmount: false,
        lifetimeDays: null,
      },
    });
    expect((await svc.product(ctx, 'g')).giftCard).toEqual({
      cardType: 'VIRTUAL',
      amounts: [{ currency: 'VND', amount: 500000 }],
      allowOpenAmount: false,
      openAmountMin: null,
      openAmountMax: null,
      lifetimeDays: null,
    });
  });

  it('resolves paths or 404s', async () => {
    const { svc } = setup();
    expect((await svc.resolve(ctx, '/tee')).id).toBe('p1');
    // CMS targets resolve only while visible (a scheduled post keeps its URL but 404s).
    expect((await svc.resolve(ctx, '/about')).id).toBe('pg1');
    await expect(svc.resolve(ctx, '/blog/soon')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.resolve(ctx, '/x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('controllers delegate with the store context', async () => {
    const catalog = {
      categoryTree: vi.fn(),
      category: vi.fn(),
      categoryProducts: vi.fn(),
      productBySlug: vi.fn(),
      product: vi.fn(),
      resolve: vi.fn(),
    };
    const c = new StorefrontCategoriesController(catalog as never);
    c.tree(ctx);
    c.get(ctx, 'c');
    c.products(ctx, 'c', {} as never);
    const p = new StorefrontProductsController(catalog as never);
    p.bySlug(ctx, 's');
    p.get(ctx, 'p');
    new StorefrontUrlController(catalog as never).resolve(ctx, { path: '/x' });
    for (const fn of Object.values(catalog))
      expect(fn).toHaveBeenCalledWith(
        ctx,
        ...(fn === catalog.categoryTree ? [] : [expect.anything()]),
        ...(fn === catalog.categoryProducts ? [expect.anything()] : []),
      );
  });

  it('cards: "from" price over in-stock variants, bundles and gift cards', async () => {
    const { svc, products } = setup();
    products.sellableUnits.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map<string, any>([
        [
          'conf',
          {
            type: 'CONFIGURABLE',
            variantIds: ['v-cheap-oos', 'v-mid', 'v-unpriced'],
          },
        ],
        ['oos', { type: 'SIMPLE', variantIds: ['v-oos'] }],
        ['gift', { type: 'GIFT_CARD', variantIds: ['v-gift'] }],
        [
          'bundle',
          {
            type: 'BUNDLE',
            variantIds: ['v-bundle'],
            bundle: {
              priceType: 'DYNAMIC',
              options: [
                {
                  isRequired: true,
                  selections: [
                    { variantId: 's-cheap', productId: 'tee', qty: 2 },
                    { variantId: 's-mid', productId: 'tee', qty: 1 },
                  ],
                },
                {
                  isRequired: false,
                  selections: [
                    { variantId: 's-opt', productId: 'socks', qty: 1 },
                  ],
                },
                {
                  isRequired: true,
                  selections: [
                    {
                      variantId: 's-hidden-cheap',
                      productId: 'hidden',
                      qty: 1,
                    },
                    { variantId: 's-x', productId: 'tee', qty: 1 },
                  ],
                },
              ],
            },
          },
        ],
        [
          'fixed',
          {
            type: 'BUNDLE',
            variantIds: ['v-fixed'],
            bundle: {
              priceType: 'FIXED',
              options: [
                {
                  isRequired: true,
                  selections: [
                    { variantId: 's-oos', productId: 'tee', qty: 1 },
                  ],
                },
              ],
            },
          },
        ],
      ]) as never,
    );
    products.visibleIds.mockImplementation(async (_c: unknown, ids: string[]) =>
      ids.filter((i) => i !== 'hidden'),
    );
    const cards = new Map(
      (await svc.cards(ctx, ['conf', 'oos', 'gift', 'bundle', 'fixed'])).map(
        (c) => [c.id, c],
      ),
    );
    expect(cards.get('conf')).toMatchObject({
      inStock: true,
      price: { amount: 500 },
    }); // the cheap variant is sold out
    expect(cards.get('oos')).toMatchObject({
      inStock: false,
      price: { amount: 500 },
    });
    expect(cards.get('gift')).toMatchObject({ inStock: true, price: null });
    // required: cheapest of 2×100 and 1×500 → 200; then 500 (the cheap one belongs to a hidden product)
    expect(cards.get('bundle')).toMatchObject({
      inStock: true,
      price: { amount: 700, formatted: '700 VND', tiers: [] },
    });
    expect(cards.get('fixed')).toMatchObject({
      inStock: false,
      price: { amount: 500 },
    });
  });
});
