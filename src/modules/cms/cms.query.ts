import { Injectable } from '@nestjs/common';
import { visibleWhere } from '../../common/content/publishing.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import type {
  BlockTargetType,
  Prisma,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { MediaQuery } from '../media/media.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { UrlRewritesQuery } from '../url-rewrites/url-rewrites.query.js';
import { renderBlocks } from './block-renderer.js';
import type {
  StorefrontBlockDto,
  StorefrontPageDto,
  StorefrontPostCardDto,
  StorefrontPostDto,
  StorefrontPostsQueryDto,
  StorefrontRegionDto,
} from './dto/storefront-cms.dto.js';

/** Content shown in a store: global or the store's own. */
const inStore = (ctx: StoreContext) => ({
  OR: [{ storeId: null }, { storeId: ctx.storeId }],
});

const live = (ctx: StoreContext, now: Date) => ({
  AND: [visibleWhere(now), inStore(ctx)],
});

/** Store-specific rows first (they override global ones). */
const storeFirst = <T extends { storeId: string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => Number(!a.storeId) - Number(!b.storeId));

const normalizeSlug = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');

const pageSelect = (chain: string[]) =>
  ({
    id: true,
    storeId: true,
    layout: true,
    publishedAt: true,
    updatedAt: true,
    translations: {
      where: { localeCode: { in: chain } },
      select: {
        localeCode: true,
        title: true,
        slug: true,
        content: true,
        metaTitle: true,
        metaDescription: true,
      },
    },
  }) as const satisfies Prisma.PageSelect;

const postSelect = (chain: string[]) =>
  ({
    id: true,
    storeId: true,
    publishedAt: true,
    featuredImageId: true,
    tags: {
      select: {
        tag: {
          select: {
            code: true,
            translations: {
              where: { localeCode: { in: chain } },
              select: { localeCode: true, name: true },
            },
          },
        },
      },
    },
    translations: {
      where: { localeCode: { in: chain } },
      select: {
        localeCode: true,
        title: true,
        slug: true,
        excerpt: true,
        content: true,
        metaTitle: true,
        metaDescription: true,
      },
    },
  }) as const satisfies Prisma.PostSelect;

type PostRow = Prisma.PostGetPayload<{
  select: ReturnType<typeof postSelect>;
}>;

/**
 * Storefront reads of CMS content (PLAN.md §9 & §14 Phase 4): only content visible now (by its publishing
 * window, independent of the scheduler) in the request's store and locale chain, with blocks
 * rendered into the HTML and placed blocks grouped by region.
 */
@Injectable()
export class CmsQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: UrlRewritesQuery,
    private readonly media: MediaQuery,
  ) {}

  /** Visible blocks by identifier (the store's own wins over the global one). */
  async blocks(
    ctx: StoreContext,
    identifiers: readonly string[],
    now = new Date(),
  ): Promise<Map<string, { title: string | null; content: string }>> {
    const out = new Map<string, { title: string | null; content: string }>();
    if (!identifiers.length) return out;
    const rows = await this.prisma.block.findMany({
      where: { identifier: { in: [...identifiers] }, ...live(ctx, now) },
      select: {
        identifier: true,
        storeId: true,
        translations: {
          where: { localeCode: { in: ctx.localeChain } },
          select: { localeCode: true, title: true, content: true },
        },
      },
    });
    for (const b of storeFirst(rows)) {
      if (out.has(b.identifier)) continue;
      const t = pickTranslation(b.translations, ctx.localeChain);
      if (t) out.set(b.identifier, { title: t.title, content: t.content });
    }
    return out;
  }

  /** Replaces `{{block id="…"}}` tokens with the visible blocks' content. */
  render(ctx: StoreContext, html: string, now = new Date()): Promise<string> {
    return renderBlocks(html, async (ids) => {
      const found = await this.blocks(ctx, ids, now);
      return new Map([...found].map(([id, b]) => [id, b.content]));
    });
  }

  async block(
    ctx: StoreContext,
    identifier: string,
  ): Promise<StorefrontBlockDto | undefined> {
    const now = new Date();
    const b = (await this.blocks(ctx, [identifier], now)).get(identifier);
    if (!b) return undefined;
    return {
      identifier,
      title: b.title,
      content: await this.render(ctx, b.content, now),
    };
  }

  /** Blocks placed on a page, post, category or product, by region and position. */
  async regions(
    ctx: StoreContext,
    targetType: BlockTargetType,
    targetId: string,
    now = new Date(),
  ): Promise<StorefrontRegionDto[]> {
    const rows = await this.prisma.blockPlacement.findMany({
      where: { targetType, targetId, block: live(ctx, now) },
      orderBy: [{ region: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      select: {
        region: true,
        block: {
          select: {
            identifier: true,
            translations: {
              where: { localeCode: { in: ctx.localeChain } },
              select: { localeCode: true, title: true, content: true },
            },
          },
        },
      },
    });
    const regions = new Map<string, StorefrontBlockDto[]>();
    for (const p of rows) {
      const t = pickTranslation(p.block.translations, ctx.localeChain);
      if (!t) continue;
      const list = regions.get(p.region) ?? [];
      list.push({
        identifier: p.block.identifier,
        title: t.title,
        content: await this.render(ctx, t.content, now),
      });
      regions.set(p.region, list);
    }
    return [...regions].map(([region, blocks]) => ({ region, blocks }));
  }

  async page(
    ctx: StoreContext,
    id: string,
  ): Promise<StorefrontPageDto | undefined> {
    const now = new Date();
    const row = await this.prisma.page.findFirst({
      where: { id, ...live(ctx, now) },
      select: pageSelect(ctx.localeChain),
    });
    return row ? this.pageView(ctx, row, now) : undefined;
  }

  /** The page at a path in this store and locale (`help/shipping`). */
  async pageByPath(
    ctx: StoreContext,
    path: string,
  ): Promise<StorefrontPageDto | undefined> {
    const slug = normalizeSlug(path);
    const now = new Date();
    const rows = await this.prisma.page.findMany({
      where: {
        ...live(ctx, now),
        translations: {
          some: { slug, localeCode: { in: ctx.localeChain } },
        },
      },
      select: pageSelect(ctx.localeChain),
    });
    const row = storeFirst(rows).find(
      (r) => pickTranslation(r.translations, ctx.localeChain)?.slug === slug,
    );
    return row ? this.pageView(ctx, row, now) : undefined;
  }

  private async pageView(
    ctx: StoreContext,
    row: Prisma.PageGetPayload<{ select: ReturnType<typeof pageSelect> }>,
    now: Date,
  ): Promise<StorefrontPageDto | undefined> {
    const t = pickTranslation(row.translations, ctx.localeChain);
    if (!t) return undefined;
    const [content, regions, paths] = await Promise.all([
      this.render(ctx, t.content, now),
      this.regions(ctx, 'PAGE', row.id, now),
      this.urls.canonicalPaths(ctx, 'CMS_PAGE', [row.id]),
    ]);
    return {
      id: row.id,
      title: t.title,
      slug: t.slug,
      urlPath: paths.get(row.id) ?? null,
      layout: row.layout,
      content,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      regions,
    };
  }

  /** Blog listing: newest first, optionally by tag code. */
  async posts(
    ctx: StoreContext,
    q: StorefrontPostsQueryDto,
  ): Promise<Paginated<StorefrontPostCardDto>> {
    const now = new Date();
    const where: Prisma.PostWhereInput = {
      ...live(ctx, now),
      translations: { some: { localeCode: { in: ctx.localeChain } } },
      ...(q.tag ? { tags: { some: { tag: { code: q.tag } } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        select: postSelect(ctx.localeChain),
        orderBy: [{ publishedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.post.count({ where }),
    ]);
    return paginated(await this.cards(ctx, rows), total, q);
  }

  async post(
    ctx: StoreContext,
    id: string,
  ): Promise<StorefrontPostDto | undefined> {
    const now = new Date();
    const row = await this.prisma.post.findFirst({
      where: { id, ...live(ctx, now) },
      select: postSelect(ctx.localeChain),
    });
    return row ? this.postView(ctx, row, now) : undefined;
  }

  async postBySlug(
    ctx: StoreContext,
    rawSlug: string,
  ): Promise<StorefrontPostDto | undefined> {
    const slug = normalizeSlug(rawSlug);
    const now = new Date();
    const rows = await this.prisma.post.findMany({
      where: {
        ...live(ctx, now),
        translations: { some: { slug, localeCode: { in: ctx.localeChain } } },
      },
      select: postSelect(ctx.localeChain),
    });
    const row = storeFirst(rows).find(
      (r) => pickTranslation(r.translations, ctx.localeChain)?.slug === slug,
    );
    return row ? this.postView(ctx, row, now) : undefined;
  }

  private async postView(
    ctx: StoreContext,
    row: PostRow,
    now: Date,
  ): Promise<StorefrontPostDto | undefined> {
    const [card] = await this.cards(ctx, [row]);
    const t = pickTranslation(row.translations, ctx.localeChain);
    if (!card || !t) return undefined;
    const [content, regions] = await Promise.all([
      this.render(ctx, t.content, now),
      this.regions(ctx, 'POST', row.id, now),
    ]);
    return {
      ...card,
      content,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      regions,
    };
  }

  private async cards(
    ctx: StoreContext,
    rows: PostRow[],
  ): Promise<StorefrontPostCardDto[]> {
    const [images, paths] = await Promise.all([
      this.media.imagesById(
        rows.map((r) => r.featuredImageId),
        ctx.localeChain,
      ),
      this.urls.canonicalPaths(
        ctx,
        'CMS_POST',
        rows.map((r) => r.id),
      ),
    ]);
    return rows.flatMap((r) => {
      const t = pickTranslation(r.translations, ctx.localeChain);
      if (!t) return [];
      return [
        {
          id: r.id,
          title: t.title,
          slug: t.slug,
          urlPath: paths.get(r.id) ?? null,
          excerpt: t.excerpt,
          publishedAt: r.publishedAt,
          featuredImage:
            (r.featuredImageId && images.get(r.featuredImageId)) || null,
          tags: r.tags
            .flatMap(({ tag }) => {
              const name = pickTranslation(tag.translations, ctx.localeChain);
              return name ? [{ code: tag.code, name: name.name }] : [];
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
      ];
    });
  }

  /** Titles of the visible pages or posts among `ids` (menus, URL resolution). */
  async visibleTitles(
    ctx: StoreContext,
    kind: 'page' | 'post',
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const args = {
      where: { id: { in: [...ids] }, ...live(ctx, new Date()) },
      select: {
        id: true,
        translations: {
          where: { localeCode: { in: ctx.localeChain } },
          select: { localeCode: true, title: true },
        },
      },
    };
    const rows =
      kind === 'page'
        ? await this.prisma.page.findMany(args)
        : await this.prisma.post.findMany(args);
    const out = new Map<string, string>();
    for (const r of rows) {
      const t = pickTranslation(r.translations, ctx.localeChain);
      if (t) out.set(r.id, t.title);
    }
    return out;
  }

  /** Which of `ids` exist (any status) — admin validation in other modules. */
  async existing(
    kind: 'page' | 'post',
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const args = {
      where: { id: { in: [...ids] } },
      select: { id: true },
    };
    const rows =
      kind === 'page'
        ? await this.prisma.page.findMany(args)
        : await this.prisma.post.findMany(args);
    return new Set(rows.map((r) => r.id));
  }
}
