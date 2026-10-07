/**
 * Phase 4 "done": content and banners publish/unpublish on schedule, and blocks render inside
 * pages and posts. Real API against PostgreSQL, password-protected Redis and MinIO; the scheduler
 * run is triggered directly (the worker does the same every minute).
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service.js';
import { eventually, rootToken, startApp } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('CMS, navigation and merchandising (e2e)', () => {
  let stack: TestStack;
  let app: INestApplication;
  let token: string;
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const admin = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) => {
    const r = http()
      [method](`/api/v1/admin${path}`)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  };
  const store = (code: string, path: string) =>
    http().get(`/api/v1/store${path}`).set('x-store', code);
  const en = (fields: object) => [{ localeCode: 'en-US', ...fields }];
  const runDue = () => app.get(SchedulerService).runDue();
  const resolve = (code: string, path: string) =>
    store(code, `/url-resolver?path=${encodeURIComponent(path)}`);

  beforeAll(async () => {
    stack = await startStack();
    app = await startApp();
    token = await rootToken(app);

    await admin('patch', '/locales/vi-VN', { isActive: true }).expect(200);
    ids.web = (
      await admin('post', '/websites', {
        code: 'main',
        name: 'Main',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    ids.en = (
      await admin('post', '/stores', {
        websiteId: ids.web,
        code: 'en',
        name: 'English',
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
    ids.vi = (
      await admin('post', '/stores', {
        websiteId: ids.web,
        code: 'vi',
        name: 'Tiếng Việt',
        defaultLocaleCode: 'vi-VN',
        defaultCurrencyCode: 'USD',
        countryCode: 'VN',
      }).expect(201)
    ).body.id;
    ids.men = (
      await admin('post', '/categories', {
        translations: [
          { localeCode: 'en-US', name: 'Men' },
          { localeCode: 'vi-VN', name: 'Nam' },
        ],
        websiteIds: [ids.web],
      }).expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
  });

  describe('blocks render inside pages and posts', () => {
    beforeAll(async () => {
      const block = async (
        identifier: string,
        content: string,
        opts: { storeId?: string; publish?: boolean; title?: string } = {},
      ) => {
        const id = (
          await admin('post', '/cms/blocks', {
            identifier,
            storeId: opts.storeId,
            translations: [
              { localeCode: 'en-US', title: opts.title, content },
              ...(opts.storeId ? [] : [{ localeCode: 'vi-VN', content }]),
            ],
          }).expect(201)
        ).body.id;
        if (opts.publish !== false)
          await admin('post', `/cms/blocks/${id}/publish`, {}).expect(200);
        return id;
      };
      ids.promo = await block(
        'promo',
        '<p>Free shipping</p>{{block id="legal"}}',
        { title: 'Promo' },
      );
      await block('legal', '<small>Terms apply</small>');
      await block('loop', '<i>loop</i>{{block id="loop"}}');
      await block('draft-only', '<b>secret</b>', { publish: false });
      // The Vietnamese store has its own "promo" (store blocks override global ones).
      const vi = (
        await admin('post', '/cms/blocks', {
          identifier: 'promo',
          storeId: ids.vi,
          translations: [{ localeCode: 'vi-VN', content: '<p>Miễn phí</p>' }],
        }).expect(201)
      ).body.id;
      await admin('post', `/cms/blocks/${vi}/publish`, {}).expect(200);
    });

    it('sanitizes HTML on save and keeps block tokens', async () => {
      const page = await admin('post', '/cms/pages', {
        translations: [
          {
            localeCode: 'en-US',
            title: 'Shipping',
            slug: 'help/shipping',
            content:
              '<h1 onclick="x()">Shipping</h1>{{block id="promo"}}<script>alert(1)</script><a href="javascript:alert(1)">x</a>{{block id="loop"}}{{block id="draft-only"}}{{block id="missing"}}',
          },
          {
            localeCode: 'vi-VN',
            title: 'Giao hàng',
            slug: 'tro-giup/giao-hang',
            content: '<h1>Giao hàng</h1>{{block id="promo"}}',
          },
        ],
      }).expect(201);
      ids.shipping = page.body.id;
      const html = page.body.translations[0].content as string;
      expect(page.body).toMatchObject({ status: 'DRAFT', visible: false });
      expect(html).not.toMatch(/script|onclick|javascript:/);
      expect(html).toContain('{{block id="promo"}}');
    });

    it('a draft page is not on the storefront; published, it renders blocks (nested, cycle-safe)', async () => {
      await store('en', '/pages/by-path?path=help/shipping').expect(404);
      await admin('post', `/cms/pages/${ids.shipping}/publish`, {}).expect(200);
      const p = await store('en', '/pages/by-path?path=/help/shipping/').expect(
        200,
      );
      expect(p.body).toMatchObject({
        id: ids.shipping,
        title: 'Shipping',
        layout: 'default',
      });
      const html = p.body.content as string;
      expect(html).toContain('<p>Free shipping</p><small>Terms apply</small>');
      expect(html.match(/<i>loop<\/i>/g)).toHaveLength(1); // a block never includes itself
      expect(html).not.toContain('secret');
      expect(html).not.toContain('{{');
      // The Vietnamese store gets its own promo block and the translated page.
      const vi = await store(
        'vi',
        '/pages/by-path?path=tro-giup/giao-hang',
      ).expect(200);
      expect(vi.body.content).toContain('<p>Miễn phí</p>');
      expect(vi.body.content).not.toContain('Free shipping');
    });

    it('places blocks in regions of pages and categories', async () => {
      await admin('post', `/cms/blocks/${ids.promo}/placements`, {
        targetType: 'PAGE',
        targetId: ids.shipping,
        region: 'sidebar',
      }).expect(201);
      await admin('post', `/cms/blocks/${ids.promo}/placements`, {
        targetType: 'CATEGORY',
        targetId: ids.men,
        region: 'top',
      }).expect(201);
      await admin('post', `/cms/blocks/${ids.promo}/placements`, {
        targetType: 'PRODUCT',
        targetId: '00000000-0000-4000-8000-000000000000',
        region: 'top',
      }).expect(400);
      const p = await store('en', `/pages/${ids.shipping}`).expect(200);
      expect(p.body.regions).toEqual([
        {
          region: 'sidebar',
          blocks: [
            {
              identifier: 'promo',
              title: 'Promo',
              content: '<p>Free shipping</p><small>Terms apply</small>',
            },
          ],
        },
      ]);
      const c = await store(
        'en',
        `/blocks/placements?targetType=CATEGORY&targetId=${ids.men}`,
      ).expect(200);
      expect(c.body[0].region).toBe('top');
      const b = await store('en', '/blocks/promo').expect(200);
      expect(b.body.content).toContain('Terms apply');
      await store('en', '/blocks/draft-only').expect(404);
    });

    it('publishes blog posts with tags, rendered blocks and /blog URLs', async () => {
      const tag = await admin('post', '/cms/tags', {
        code: 'news',
        translations: [{ localeCode: 'en-US', name: 'News' }],
      }).expect(201);
      const post = await admin('post', '/cms/posts', {
        tagIds: [tag.body.id],
        translations: en({
          title: 'Hello World',
          excerpt: 'First post',
          content: '<p>Welcome</p>{{block id="legal"}}',
        }),
      }).expect(201);
      ids.post = post.body.id;
      expect(post.body.translations[0].slug).toBe('hello-world');
      await admin('post', `/cms/posts/${ids.post}/publish`, {}).expect(200);
      const list = await store('en', '/posts?tag=news').expect(200);
      expect(list.body).toMatchObject({ total: 1 });
      expect(list.body.data[0]).toMatchObject({
        id: ids.post,
        title: 'Hello World',
        excerpt: 'First post',
        tags: [{ code: 'news', name: 'News' }],
      });
      const one = await store('en', '/posts/by-slug/hello-world').expect(200);
      expect(one.body.content).toBe('<p>Welcome</p><small>Terms apply</small>');
      const r = await eventually(
        () => resolve('en', '/blog/hello-world'),
        (res) => res.status === 200,
      );
      expect(r.body).toMatchObject({ type: 'CMS_POST', id: ids.post });
      expect(one.body.urlPath ?? r.body.canonicalPath).toBe('blog/hello-world');
    });

    it('gives pages URLs per store and locale, refusing slugs that belong to the catalog', async () => {
      const r = await eventually(
        () => resolve('en', '/help/shipping'),
        (res) => res.status === 200,
      );
      expect(r.body).toMatchObject({ type: 'CMS_PAGE', id: ids.shipping });
      await eventually(
        () => resolve('vi', '/tro-giup/giao-hang'),
        (res) => res.status === 200,
      );
      const clash = await admin('post', '/cms/pages', {
        translations: en({ title: 'Men', slug: 'men' }),
      }).expect(409);
      expect(JSON.stringify(clash.body)).toContain('category');
      await admin('post', '/cms/pages', {
        translations: en({ title: 'Again', slug: 'help/shipping' }),
      }).expect(409);
    });

    it('a store page shadows the global page with the same slug', async () => {
      const make = async (storeId?: string) => {
        const id = (
          await admin('post', '/cms/pages', {
            storeId,
            translations: [
              { localeCode: 'en-US', title: 'About', slug: 'about' },
              { localeCode: 'vi-VN', title: 'Giới thiệu', slug: 'about' },
            ],
          }).expect(201)
        ).body.id;
        await admin('post', `/cms/pages/${id}/publish`, {}).expect(200);
        return id;
      };
      const global = await make();
      const local = await make(ids.vi);
      expect((await store('en', '/pages/by-path?path=about')).body.id).toBe(
        global,
      );
      expect((await store('vi', '/pages/by-path?path=about')).body.id).toBe(
        local,
      );
      const vi = await eventually(
        () => resolve('vi', '/about'),
        (res) => res.body?.id === local,
      );
      expect(vi.body.id).toBe(local);
      expect((await resolve('en', '/about')).body.id).toBe(global);
    });

    it('a store created later gets the content URLs', async () => {
      await admin('post', '/stores', {
        websiteId: ids.web,
        code: 'en2',
        name: 'English 2',
        defaultLocaleCode: 'en-US',
        defaultCurrencyCode: 'USD',
        countryCode: 'GB',
      }).expect(201);
      const r = await eventually(
        () => resolve('en2', '/help/shipping'),
        (res) => res.status === 200,
      );
      expect(r.body.id).toBe(ids.shipping);
    });
  });

  describe('publishing on schedule', () => {
    it('a scheduled page appears on time, then the scheduler records it as published', async () => {
      const id = (
        await admin('post', '/cms/pages', {
          translations: en({ title: 'Black Friday', content: '<p>Deals</p>' }),
        }).expect(201)
      ).body.id;
      const at = inMs(2500);
      const s = await admin('post', `/cms/pages/${id}/publish`, { at }).expect(
        200,
      );
      expect(s.body).toMatchObject({
        status: 'SCHEDULED',
        publishedAt: at,
        visible: false,
      });
      // The scheduler mirrors the state (after-commit listener).
      const pending = await eventually(
        () => admin('get', `/schedules?targetId=${id}&status=PENDING`),
        (res) => res.body.total === 1,
      );
      expect(pending.body.data[0]).toMatchObject({
        targetType: 'PAGE',
        action: 'PUBLISH',
      });
      await store('en', '/pages/by-path?path=black-friday').expect(404);
      // The URL is reserved, but resolves only once the page is visible.
      await eventually(
        () => admin('get', `/url-rewrites?targetId=${id}`),
        (res) => res.body.total > 0,
      );
      await resolve('en', '/black-friday').expect(404);
      expect(await runDue()).toBe(0);

      await sleep(2700);
      // Visible by its publish time, even before the scheduler has run.
      await store('en', '/pages/by-path?path=black-friday').expect(200);
      await resolve('en', '/black-friday').expect(200);
      expect(await runDue()).toBeGreaterThanOrEqual(1);
      const done = await eventually(
        () => admin('get', `/cms/pages/${id}`),
        (res) => res.body.status === 'PUBLISHED',
      );
      expect(done.body.visible).toBe(true);
      const audit = await eventually(
        () => admin('get', `/audit-logs?entityId=${id}`),
        (res) =>
          res.body.data?.some((l: Body) => l.action === 'page.published'),
      );
      expect(
        audit.body.data.find((l: Body) => l.action === 'page.published')
          .actorType,
      ).toBe('system');
    });

    it('banners are shown only inside their publishing window', async () => {
      const id = (
        await admin('post', '/merchandising/banners', {
          placement: 'home.hero',
          name: 'Flash sale',
          linkUrl: '/sale',
          translations: en({ title: 'Flash sale', ctaLabel: 'Shop now' }),
        }).expect(201)
      ).body.id;
      await admin('post', '/merchandising/banners', {
        placement: 'home.hero',
        name: 'Bad link',
        linkUrl: 'javascript:alert(1)',
      }).expect(400);
      await admin('post', `/merchandising/banners/${id}/publish`, {
        at: inMs(2000),
      }).expect(200);
      const unpublish = await admin(
        'post',
        `/merchandising/banners/${id}/unpublish`,
        { at: inMs(4500) },
      ).expect(200);
      expect(unpublish.body.status).toBe('SCHEDULED');
      const hero = () => store('en', '/banners?placement=home.hero');
      expect((await hero()).body).toEqual([]);
      await sleep(2200);
      expect((await hero()).body).toEqual([
        {
          id,
          placement: 'home.hero',
          title: 'Flash sale',
          subtitle: null,
          ctaLabel: 'Shop now',
          linkUrl: '/sale',
          image: null,
        },
      ]);
      await sleep(2500);
      expect((await hero()).body).toEqual([]);
      await runDue();
      const archived = await eventually(
        () => admin('get', `/merchandising/banners/${id}`),
        (res) => res.body.status === 'ARCHIVED',
      );
      expect(archived.body.visible).toBe(false);
      const history = await admin('get', `/schedules?targetId=${id}`).expect(
        200,
      );
      expect(
        history.body.data.map((s: Body) => `${s.action}:${s.status}`).sort(),
      ).toEqual(['PUBLISH:DONE', 'UNPUBLISH:DONE']);
      expect(history.body.data[0].targetLabel).toBe('Flash sale');
    });

    it('unpublishing content that never went live returns it to draft and cancels its schedule', async () => {
      const id = (
        await admin('post', '/cms/posts', {
          translations: en({ title: 'Teaser' }),
        }).expect(201)
      ).body.id;
      await admin('post', `/cms/posts/${id}/publish`, {
        at: inMs(3_600_000),
      }).expect(200);
      await eventually(
        () => admin('get', `/schedules?targetId=${id}&status=PENDING`),
        (res) => res.body.total === 1,
      );
      const r = await admin('post', `/cms/posts/${id}/unpublish`, {}).expect(
        200,
      );
      expect(r.body).toMatchObject({ status: 'DRAFT', publishedAt: null });
      await eventually(
        () => admin('get', `/schedules?targetId=${id}&status=CANCELLED`),
        (res) => res.body.total === 1,
      );
      await admin('post', `/cms/posts/${id}/unpublish`, {}).expect(409);
      await admin('post', `/cms/posts/${id}/publish`, {
        at: 'tomorrow',
      }).expect(400);
    });

    it('sliders follow the same schedule; inactive slides are hidden', async () => {
      const id = (
        await admin('post', '/merchandising/sliders', {
          code: 'home',
          name: 'Home',
          autoplayMs: 5000,
        }).expect(201)
      ).body.id;
      for (const [i, isActive] of [
        [1, true],
        [0, true],
        [2, false],
      ] as const)
        await admin('post', `/merchandising/sliders/${id}/slides`, {
          position: i,
          isActive,
          linkUrl: `/s${i}`,
          translations: en({ title: `Slide ${i}` }),
        }).expect(201);
      await store('en', '/sliders/home').expect(404);
      await admin('post', `/merchandising/sliders/${id}/publish`, {}).expect(
        200,
      );
      const s = await store('en', '/sliders/home').expect(200);
      expect(s.body).toMatchObject({ code: 'home', autoplayMs: 5000 });
      expect(s.body.slides.map((x: Body) => x.title)).toEqual([
        'Slide 0',
        'Slide 1',
      ]);
    });
  });

  describe('navigation', () => {
    it('resolves menu links to paths and hides links to hidden targets', async () => {
      const draft = (
        await admin('post', '/cms/pages', {
          translations: en({ title: 'Hidden' }),
        }).expect(201)
      ).body.id;
      const menu = (
        await admin('post', '/navigation/menus', {
          code: 'main',
          name: 'Main',
        }).expect(201)
      ).body.id;
      const item = (body: object) =>
        admin('post', `/navigation/menus/${menu}/items`, body);
      const help = (
        await item({
          linkType: 'PAGE',
          targetId: ids.shipping,
          position: 1,
        }).expect(201)
      ).body.id;
      await item({
        parentId: help,
        linkType: 'POST',
        targetId: ids.post,
        labels: [{ localeCode: 'en-US', label: 'Blog' }],
      }).expect(201);
      await item({
        linkType: 'CATEGORY',
        targetId: ids.men,
        position: 0,
      }).expect(201);
      await item({
        linkType: 'URL',
        url: '/sale',
        position: 2,
        openInNewTab: true,
        labels: [{ localeCode: 'en-US', label: 'Sale' }],
      }).expect(201);
      await item({ linkType: 'PAGE', targetId: draft, position: 3 }).expect(
        201,
      );
      await item({ linkType: 'URL', url: '//evil.example' }).expect(400);
      await item({ linkType: 'PAGE' }).expect(400);
      await admin('patch', `/navigation/menu-items/${help}`, {
        parentId: help,
      }).expect(400);

      const m = await eventually(
        () => store('en', '/menus/main'),
        (res) => res.body.items?.length === 3,
      );
      expect(
        m.body.items.map((i: Body) => [i.label, i.url, i.children.length]),
      ).toEqual([
        ['Men', '/men', 0],
        ['Shipping', '/help/shipping', 1],
        ['Sale', '/sale', 0],
      ]);
      expect(m.body.items[1].children[0]).toMatchObject({
        label: 'Blog',
        url: '/blog/hello-world',
      });
      // Deleting a linked page deactivates its items (with their sub-items hidden).
      await admin('delete', `/cms/pages/${ids.shipping}`).expect(204);
      const after = await eventually(
        () => store('en', '/menus/main'),
        (res) => res.body.items?.length === 2,
      );
      expect(after.body.items.map((i: Body) => i.label)).toEqual([
        'Men',
        'Sale',
      ]);
      // The item is switched off by an after-commit listener; the storefront hides it earlier.
      const detail = await eventually(
        () => admin('get', `/navigation/menus/${menu}`),
        (res) =>
          res.body.items?.find((i: Body) => i.id === help)?.isActive === false,
      );
      expect(detail.status).toBe(200);
      await resolve('en', '/help/shipping').expect(404);
    });
  });
});
