import { Injectable } from '@nestjs/common';
import type { UrlTargetType } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { StoreContext } from '../stores/context/store-context.js';
import type { UrlResolutionDto } from './dto/url-rewrite.dto.js';
import { normalizePath } from './url-paths.js';

const TARGET_LABEL: Record<UrlTargetType, string> = {
  PRODUCT: 'a product',
  CATEGORY: 'a category',
  CMS_PAGE: 'a page',
  CMS_POST: 'a blog post',
  CUSTOM: 'a redirect',
};

export const describeTarget = (t: UrlTargetType): string => TARGET_LABEL[t];

/** Storefront URL lookups. Paths are returned without leading slash (`men/t-shirts`). */
@Injectable()
export class UrlRewritesQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** Canonical path of each target in the request's store and locale. */
  async canonicalPaths(
    ctx: StoreContext,
    type: UrlTargetType,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.urlRewrite.findMany({
      where: {
        storeId: ctx.storeId,
        localeCode: ctx.localeCode,
        targetType: type,
        targetId: { in: [...ids] },
        redirectType: null,
      },
      select: { targetId: true, requestPath: true },
    });
    return new Map(rows.map((r) => [r.targetId!, r.requestPath]));
  }

  /**
   * URLs among `candidates` held by other targets (canonical URLs and custom redirects; redirects
   * left by renamed entities may be taken over). `storeId` limits the check to one store;
   * `ignoreType` skips rows of a type whose owner checks duplicates itself (CMS scopes).
   */
  async taken(
    type: UrlTargetType,
    selfId: string | null,
    candidates: readonly { localeCode: string; path: string }[],
    opts: { storeId?: string | null; ignoreType?: UrlTargetType } = {},
  ): Promise<
    { requestPath: string; localeCode: string; targetType: UrlTargetType }[]
  > {
    if (!candidates.length) return [];
    return this.prisma.urlRewrite.findMany({
      where: {
        OR: candidates.map((c) => ({
          localeCode: c.localeCode,
          requestPath: c.path,
        })),
        AND: [
          { OR: [{ redirectType: null }, { isSystem: false }] },
          ...(selfId ? [{ NOT: { targetType: type, targetId: selfId } }] : []),
          ...(opts.ignoreType
            ? [{ targetType: { not: opts.ignoreType } }]
            : []),
        ],
        ...(opts.storeId ? { storeId: opts.storeId } : {}),
      },
      select: { requestPath: true, localeCode: true, targetType: true },
      distinct: ['requestPath', 'localeCode'],
      take: 10,
    });
  }

  async resolve(
    ctx: StoreContext,
    rawPath: string,
  ): Promise<UrlResolutionDto | undefined> {
    const requestPath = normalizePath(rawPath);
    const r = await this.prisma.urlRewrite.findUnique({
      where: {
        storeId_localeCode_requestPath: {
          storeId: ctx.storeId,
          localeCode: ctx.localeCode,
          requestPath,
        },
      },
      select: {
        targetType: true,
        targetId: true,
        targetPath: true,
        redirectType: true,
      },
    });
    if (!r) return undefined;
    if (r.targetType === 'CUSTOM')
      return {
        type: 'CUSTOM',
        id: null,
        canonicalPath: null,
        redirectStatus: r.redirectType,
        location: r.targetPath,
      };
    const canonical =
      r.redirectType === null
        ? requestPath
        : (await this.canonicalPaths(ctx, r.targetType, [r.targetId!])).get(
            r.targetId!,
          );
    // A redirect whose target has no canonical URL here any more is a dead end.
    if (!canonical) return undefined;
    return {
      type: r.targetType,
      id: r.targetId,
      canonicalPath: canonical,
      redirectStatus: r.redirectType,
      location: r.redirectType ? `/${canonical}` : null,
    };
  }
}
