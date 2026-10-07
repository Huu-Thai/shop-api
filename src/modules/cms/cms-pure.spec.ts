import { blockIdentifiers, renderBlocks } from './block-renderer.js';
import { contentPaths, POST_PREFIX } from './content-urls.js';
import { sanitizeContent } from './html.js';

describe('sanitizeContent', () => {
  it('strips scripts, handlers, javascript: URLs and foreign iframes; keeps block tokens', () => {
    const out = sanitizeContent(
      '<p onclick="x()">Hi {{block id="promo"}}</p><script>alert(1)</script>' +
        '<a href="javascript:alert(1)">x</a><a href="/ok" target="_blank">ok</a>' +
        '<iframe src="https://evil.example/x"></iframe>' +
        '<iframe src="https://www.youtube.com/embed/abc"></iframe><img src="data:image/png;base64,AA">',
    );
    expect(out).toContain('<p>Hi {{block id="promo"}}</p>');
    expect(out).not.toMatch(/script|onclick|javascript|evil|data:/);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('src="https://www.youtube.com/embed/abc"');
  });
});

describe('block renderer', () => {
  const blocks: Record<string, string> = {
    a: 'A{{block id="b"}}',
    b: "B{{block id='c'}}",
    c: 'C{{block id=&quot;d&quot;}}',
    d: 'D',
    self: 'S{{ block id="self" }}',
  };
  const load = vi.fn(async (ids: string[]) => {
    return new Map(ids.filter((i) => blocks[i]).map((i) => [i, blocks[i]]));
  });

  it('finds identifiers (also HTML-escaped quotes)', () => {
    expect(
      blockIdentifiers(
        '{{block id="x"}} {{block id=&quot;y&quot;}} {{block id="x"}}',
      ),
    ).toEqual(['x', 'y']);
  });

  it('renders nested blocks up to the depth limit, once per level', async () => {
    load.mockClear();
    expect(await renderBlocks('<{{block id="a"}}>', load)).toBe('<ABC>');
    expect(load).toHaveBeenCalledTimes(3);
    expect(await renderBlocks('{{block id="a"}}', load, 4)).toBe('ABCD');
  });

  it('cycles, unknown blocks and content without tokens render safely', async () => {
    expect(
      await renderBlocks('{{block id="self"}}|{{block id="nope"}}', load),
    ).toBe('S|');
    load.mockClear();
    expect(await renderBlocks('plain', load)).toBe('plain');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('content paths', () => {
  const stores = [
    {
      id: 's1',
      websiteId: 'w',
      defaultLocaleCode: 'en-US',
      localeCodes: ['en-US', 'vi-VN'],
    },
    {
      id: 's2',
      websiteId: 'w',
      defaultLocaleCode: 'en-US',
      localeCodes: ['en-US'],
    },
  ];
  const fallbacks = new Map<string, string | null>([
    ['en-US', null],
    ['vi-VN', 'en-US'],
  ]);

  it('global content gets a path per store and locale (with fallback translations)', () => {
    const item = {
      id: 'g',
      storeId: null,
      translations: [{ localeCode: 'en-US', slug: 'about' }],
    };
    expect(contentPaths(item, stores, fallbacks, POST_PREFIX)).toEqual([
      { storeId: 's1', localeCode: 'en-US', path: 'blog/about' },
      { storeId: 's1', localeCode: 'vi-VN', path: 'blog/about' },
      { storeId: 's2', localeCode: 'en-US', path: 'blog/about' },
    ]);
  });

  it('store content stays in its store and shadows global content with the same slug', () => {
    const local = {
      id: 'l',
      storeId: 's1',
      translations: [{ localeCode: 'en-US', slug: 'about' }],
    };
    const global = { ...local, id: 'g', storeId: null };
    expect(contentPaths(local, stores, fallbacks, '')).toHaveLength(2);
    expect(contentPaths(global, stores, fallbacks, '', [local])).toEqual([
      { storeId: 's2', localeCode: 'en-US', path: 'about' },
    ]);
    expect(
      contentPaths({ ...global, translations: [] }, stores, fallbacks, ''),
    ).toEqual([]);
  });
});
