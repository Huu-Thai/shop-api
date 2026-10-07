import { Injectable } from '@nestjs/common';
import { LIVE_STATUSES } from '../../common/content/publishing.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StoresQuery } from '../stores/stores.query.js';
import { UrlRewritesService } from '../url-rewrites/url-rewrites.service.js';
import {
  contentPaths,
  PAGE_PREFIX,
  POST_PREFIX,
  type SluggedContent,
} from './content-urls.js';

export type UrlContentKind = 'page' | 'post';

const KIND = {
  page: { type: 'CMS_PAGE', prefix: PAGE_PREFIX },
  post: { type: 'CMS_POST', prefix: POST_PREFIX },
} as const;

/** Content on the publishing track keeps its URLs (visibility is checked when resolving). */
const liveWhere = (now: Date) => ({
  status: { in: [...LIVE_STATUSES] },
  OR: [{ unpublishedAt: null }, { unpublishedAt: { gt: now } }],
});

const SLUGGED = {
  id: true,
  storeId: true,
  translations: { select: { localeCode: true, slug: true } },
} as const;

/**
 * URL rewrites of pages (`/<slug>`) and posts (`/blog/<slug>`) per store and locale, written
 * through UrlRewritesService (same projection and redirects as the catalog).
 */
@Injectable()
export class CmsUrlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rewrites: UrlRewritesService,
    private readonly stores: StoresQuery,
  ) {}

  /**
   * Rebuilds an item and — for store-specific items — the global items it shadows (or stops
   * shadowing). Paths are released before they are claimed, so no rebuild collides.
   */
  async rebuild(
    kind: UrlContentKind,
    id: string,
    storeId: string | null,
    previousSlugs: readonly string[] = [],
  ): Promise<void> {
    if (!storeId) return this.rebuildOne(kind, id);
    const [item] = await this.live(kind, { id });
    const slugs = [
      ...new Set([
        ...previousSlugs,
        ...(item?.translations.map((t) => t.slug) ?? []),
      ]),
    ];
    const globals = slugs.length
      ? await this.live(kind, {
          storeId: null,
          translations: { some: { slug: { in: slugs } } },
        })
      : [];
    if (item) {
      for (const g of globals) await this.rebuildOne(kind, g.id);
      await this.rebuildOne(kind, id);
    } else {
      await this.rebuildOne(kind, id);
      for (const g of globals) await this.rebuildOne(kind, g.id);
    }
  }

  async rebuildOne(kind: UrlContentKind, id: string): Promise<void> {
    const [item] = await this.live(kind, { id });
    let desired: ReturnType<typeof contentPaths> = [];
    if (item) {
      const snap = await this.stores.snapshot(true);
      const shadows = item.storeId
        ? []
        : await this.live(kind, {
            storeId: { not: null },
            translations: {
              some: { slug: { in: item.translations.map((t) => t.slug) } },
            },
          });
      desired = contentPaths(
        item,
        [...snap.byId.values()],
        snap.fallbacks,
        KIND[kind].prefix,
        shadows,
      );
    }
    await this.rewrites.sync({ type: KIND[kind].type, id }, desired);
  }

  /** Every live page and post (a store was created or its locales changed). */
  async rebuildAll(): Promise<number> {
    let n = 0;
    for (const kind of ['page', 'post'] as const) {
      // Global items first: they release paths that store-specific items then claim.
      const items = await this.live(kind, {});
      items.sort((a, b) => Number(!!a.storeId) - Number(!!b.storeId));
      for (const it of items) await this.rebuildOne(kind, it.id);
      n += items.length;
    }
    return n;
  }

  private live(
    kind: UrlContentKind,
    where: Prisma.PageWhereInput & Prisma.PostWhereInput,
  ): Promise<SluggedContent[]> {
    const args = {
      where: { AND: [where, liveWhere(new Date())] },
      select: SLUGGED,
    };
    return kind === 'page'
      ? this.prisma.page.findMany(args)
      : this.prisma.post.findMany(args);
  }
}
