import {
  categoryPath,
  desiredPaths,
  type ExistingRewrite,
  normalizePath,
  planRewrites,
  productPath,
} from './url-paths.js';

describe('normalizePath', () => {
  it.each([
    ['/Men/T-Shirts/', 'men/t-shirts'],
    ['//a//b?x=1#top', 'a/b'],
    ['/%C3%A1o-thun', 'áo-thun'],
    ['/%E0%A4%A', '%e0%a4%a'],
    ['', ''],
  ])('%s → %s', (raw, out) => expect(normalizePath(raw)).toBe(out));
});

describe('desiredPaths', () => {
  const fallbacks = new Map<string, string | null>([
    ['vi-VN', 'en-US'],
    ['en-US', null],
  ]);
  const stores = [
    {
      id: 'us',
      websiteId: 'w1',
      defaultLocaleCode: 'en-US',
      localeCodes: ['en-US'],
    },
    {
      id: 'vn',
      websiteId: 'w2',
      defaultLocaleCode: 'vi-VN',
      localeCodes: ['vi-VN', 'en-US'],
    },
  ];

  it('uses each locale’s slug, falling back along the chain', () => {
    const p = productPath([{ localeCode: 'en-US', slug: 'classic-tee' }]);
    expect(desiredPaths(stores, fallbacks, p)).toEqual([
      { storeId: 'us', localeCode: 'en-US', path: 'classic-tee' },
      { storeId: 'vn', localeCode: 'vi-VN', path: 'classic-tee' },
      { storeId: 'vn', localeCode: 'en-US', path: 'classic-tee' },
    ]);
    const vi = productPath([
      { localeCode: 'en-US', slug: 'classic-tee' },
      { localeCode: 'vi-VN', slug: 'ao-thun' },
    ]);
    expect(
      desiredPaths(stores, fallbacks, vi).find((d) => d.localeCode === 'vi-VN')
        ?.path,
    ).toBe('ao-thun');
  });

  it('builds category paths from the root and skips untranslated ancestry', () => {
    const men = { translations: [{ localeCode: 'en-US', slug: 'men' }] };
    const tees = { translations: [{ localeCode: 'vi-VN', slug: 'ao-thun' }] };
    expect(categoryPath([men, tees])(['vi-VN', 'en-US'])).toBe('men/ao-thun');
    expect(categoryPath([men, tees])(['en-US'])).toBeUndefined();
  });
});

describe('planRewrites', () => {
  const T = { type: 'PRODUCT', id: 'p1' };
  const row = (o: Partial<ExistingRewrite>): ExistingRewrite => ({
    id: 'r',
    storeId: 's1',
    localeCode: 'en-US',
    requestPath: 'x',
    targetType: 'PRODUCT',
    targetId: 'p1',
    redirectType: null,
    isSystem: true,
    ...o,
  });
  const want = (path: string, storeId = 's1') => ({
    storeId,
    localeCode: 'en-US',
    path,
  });

  it('creates a canonical URL for a new target', () => {
    expect(planRewrites(T, [want('tee')], [], [])).toEqual({
      delete: [],
      update: [],
      create: [
        {
          storeId: 's1',
          localeCode: 'en-US',
          requestPath: 'tee',
          redirectType: null,
        },
      ],
      collisions: [],
    });
  });

  it('keeps an unchanged URL', () => {
    expect(
      planRewrites(
        T,
        [want('tee')],
        [row({ id: 'a', requestPath: 'tee' })],
        [],
      ),
    ).toEqual({ delete: [], update: [], create: [], collisions: [] });
  });

  it('turns the old URL into a 301 when the slug changes', () => {
    const plan = planRewrites(
      T,
      [want('new-tee')],
      [row({ id: 'a', requestPath: 'tee' })],
      [],
    );
    expect(plan.update).toEqual([{ id: 'a', data: { redirectType: 301 } }]);
    expect(plan.create).toEqual([
      {
        storeId: 's1',
        localeCode: 'en-US',
        requestPath: 'new-tee',
        redirectType: null,
      },
    ]);
  });

  it('reverting a slug revives the redirect as canonical', () => {
    const plan = planRewrites(
      T,
      [want('tee')],
      [
        row({ id: 'a', requestPath: 'new-tee' }),
        row({ id: 'b', requestPath: 'tee', redirectType: 301 }),
      ],
      [],
    );
    expect(plan.update).toEqual([
      { id: 'a', data: { redirectType: 301 } },
      { id: 'b', data: { redirectType: null } },
    ]);
    expect(plan.create).toEqual([]);
  });

  it('takes over another target’s redirect but never its canonical URL or a custom rewrite', () => {
    const takeover = planRewrites(
      T,
      [want('tee')],
      [],
      [row({ id: 'o', requestPath: 'tee', targetId: 'p2', redirectType: 301 })],
    );
    expect(takeover.update).toEqual([
      {
        id: 'o',
        data: { targetType: 'PRODUCT', targetId: 'p1', redirectType: null },
      },
    ]);
    expect(
      planRewrites(
        T,
        [want('tee')],
        [],
        [row({ id: 'o', requestPath: 'tee', targetId: 'p2' })],
      ).collisions,
    ).toEqual([want('tee')]);
    expect(
      planRewrites(
        T,
        [want('tee')],
        [],
        [
          row({
            id: 'c',
            requestPath: 'tee',
            targetType: 'CUSTOM',
            targetId: null,
            isSystem: false,
            redirectType: 302,
          }),
        ],
      ).collisions,
    ).toHaveLength(1);
  });

  it('removes every URL of a store the target left (redirects included)', () => {
    const plan = planRewrites(
      T,
      [],
      [
        row({ id: 'a', requestPath: 'tee' }),
        row({ id: 'b', requestPath: 'old', redirectType: 301 }),
      ],
      [],
    );
    expect(plan.delete).toEqual(['a', 'b']);
  });
});
