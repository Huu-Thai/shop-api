import { BadRequestException } from '@nestjs/common';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import { buildDocument, weightedText } from './document-builder.js';
import { runSearch } from './search-orchestrator.js';
import { fold, plainText, terms } from './search-text.js';
import {
  BROWSE_VISIBILITY,
  indexName,
  SEARCH_VISIBILITY,
  type EngineQuery,
  type SearchProvider,
} from './search.types.js';

describe('search text', () => {
  it('strips HTML and entities, folds accents, splits terms', () => {
    expect(
      plainText(
        '<p>A <b>soft</b>&nbsp;tee &amp; more<script>x()</script>&#39;s</p>',
      ),
    ).toBe("A soft tee & more 's");
    expect(plainText(null)).toBe('');
    expect(plainText('abcdef', 3)).toBe('abc');
    expect(fold('Áo thun Đỏ')).toBe('ao thun do');
    expect(terms('Áo-thun, cổ điển! 42')).toEqual([
      'ao',
      'thun',
      'co',
      'dien',
      '42',
    ]);
    expect(terms('日本 語')).toEqual(['日本', '語']);
  });

  it('index names are engine-safe and include the generation', () => {
    expect(indexName('shop', 3, 'VN-vi', 'vi-VN')).toBe('shop_g3_vn-vi_vi-vn');
    expect(indexName('p', 1, 'a.b', 'en')).toBe('p_g1_a_b_en');
    expect(SEARCH_VISIBILITY).toContain('SEARCH');
    expect(BROWSE_VISIBILITY).toContain('CATALOG');
  });
});

describe('buildDocument', () => {
  const attr = (
    code: string,
    type: string,
    flags: { isFilterable?: boolean; isSearchable?: boolean },
    labels: Record<string, string> = {},
  ) =>
    [
      code,
      {
        def: {
          code,
          type,
          isFilterable: !!flags.isFilterable,
          isSearchable: !!flags.isSearchable,
          position: 0,
        },
        label: code,
        options: new Map(
          Object.entries(labels).map(([k, label], position) => [
            k,
            { label, swatch: null, position },
          ]),
        ),
      },
    ] as const;
  it('merges product and variant option values into facets and searchable text', () => {
    const attrs = new Map([
      attr(
        'color',
        'SELECT',
        { isFilterable: true, isSearchable: true },
        { red: 'Đỏ', blue: 'Xanh' },
      ),
      attr('size', 'SELECT', { isFilterable: true }),
      attr('eco', 'BOOLEAN', { isFilterable: true }),
      attr('material', 'TEXT', { isSearchable: true, isFilterable: true }),
      attr('unused', 'SELECT', { isFilterable: true }),
    ]) as never;
    const d = buildDocument(
      {
        id: 'p',
        sku: 'tee',
        type: 'CONFIGURABLE',
        name: 'Áo thun',
        slug: 'ao-thun',
        shortDescription: '<i>Soft</i>',
        description: '<p>Long</p>',
        attributes: { color: 'red', eco: true, material: 'Cotton' },
        variants: [
          {
            id: 'v1',
            sku: 'tee-b',
            optionValues: { color: 'blue', size: 'm' },
          },
          { id: 'v2', sku: 'TEE-R', optionValues: { color: 'red', size: 's' } },
        ],
        visibility: 'CATALOG_SEARCH',
        createdAt: new Date(5),
      } as never,
      { price: 2500, inStock: true },
      attrs,
      ['men', 'tees', 'men'],
    );
    expect(d).toMatchObject({
      nameSort: 'ao thun',
      skus: ['TEE', 'TEE-B', 'TEE-R'],
      shortDescription: 'Soft',
      description: 'Long',
      facets: { color: ['blue', 'red'], size: ['m', 's'], eco: ['true'] },
      attributesText: 'Đỏ Xanh Cotton',
      categoryIds: ['men', 'tees'],
      price: 2500,
      createdAt: 5,
    });
    expect(d.facets).not.toHaveProperty('material');
    expect(weightedText(d)).toEqual({
      a: 'Áo thun TEE TEE-B TEE-R',
      b: 'Đỏ Xanh Cotton Soft',
      c: 'Long',
    });
  });
});

describe('runSearch (disjunctive facets on any engine)', () => {
  it('re-counts selected facets without their own filter and the price range without the price filter', async () => {
    const calls: EngineQuery[] = [];
    const provider = {
      query: vi.fn(async (_t: unknown, q: EngineQuery) => {
        calls.push(q);
        if (q.limit === 0 && q.priceStats)
          return {
            ids: [],
            total: 9,
            facets: {},
            priceRange: { min: 1, max: 99 },
          };
        if (q.limit === 0)
          return {
            ids: [],
            total: 5,
            facets: { [q.facetCodes[0]]: { red: 2, blue: 3 } },
            priceRange: null,
          };
        return {
          ids: ['a'],
          total: 1,
          facets: { size: { m: 1 }, category: { c: 1 } },
          priceRange: null,
        };
      }),
    } as unknown as SearchProvider;
    const r = await runSearch(
      provider,
      { storeId: 's', storeCode: 'x', localeCode: 'en', index: 'i' },
      {
        text: 't',
        filters: {
          facets: { color: ['red'], material: ['x'], empty: [] },
          priceMin: 1,
          visibility: ['CATALOG_SEARCH'],
        },
        sort: 'relevance',
        offset: 0,
        limit: 10,
        facetCodes: ['color', 'size', 'empty'],
      },
    );
    expect(r).toEqual({
      ids: ['a'],
      total: 1,
      facets: {
        size: { m: 1 },
        category: { c: 1 },
        color: { red: 2, blue: 3 },
      },
      priceRange: { min: 1, max: 99 },
    });
    expect(calls[0]).toMatchObject({
      facetCodes: ['size', 'empty'],
      categoryFacet: true,
      priceStats: false,
    });
    expect(calls[1].filters.facets).toEqual({ material: ['x'], empty: [] });
    expect(calls[2].filters).toMatchObject({
      priceMin: undefined,
      priceMax: undefined,
    });
  });
});

describe('SecretsService', () => {
  it('seals and opens with the key; refuses without one', () => {
    const s = new SecretsService({ get: () => '0f'.repeat(32) } as never);
    expect(s.enabled).toBe(true);
    const sealed = s.seal({ url: 'x', apiKey: 'k' });
    expect(sealed).not.toContain('k"');
    expect(s.open(sealed)).toEqual({ url: 'x', apiKey: 'k' });
    const none = new SecretsService({ get: () => undefined } as never);
    expect(none.enabled).toBe(false);
    expect(() => none.seal({})).toThrow(BadRequestException);
    expect(() => none.open('x')).toThrow('not configured');
  });
});
