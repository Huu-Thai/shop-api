import { Injectable } from '@nestjs/common';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { PrismaService } from '../../database/prisma.service.js';
import { idsInPath } from './category-tree.js';

export interface CategoryNode {
  id: string;
  parentId: string | null;
  path: string;
  level: number;
  position: number;
  isActive: boolean;
  includeInMenu: boolean;
  websiteIds: string[];
  translations: {
    localeCode: string;
    name: string;
    slug: string;
    description: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }[];
}

/** A category as one storefront sees it: visible in the website, with its translation resolved. */
export interface VisibleCategory {
  id: string;
  parentId: string | null;
  level: number;
  position: number;
  includeInMenu: boolean;
  name: string;
  slug: string;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
}

const NODE_SELECT = {
  id: true,
  parentId: true,
  path: true,
  level: true,
  position: true,
  isActive: true,
  includeInMenu: true,
  websites: { select: { websiteId: true } },
  translations: {
    select: {
      localeCode: true,
      name: true,
      slug: true,
      description: true,
      metaTitle: true,
      metaDescription: true,
    },
  },
} as const;

/** Read-only category tree access for the storefront and URL rewrites. */
@Injectable()
export class CategoriesQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** The nodes and all their ancestors, keyed by id. */
  async withAncestors(
    ids: readonly string[],
  ): Promise<Map<string, CategoryNode>> {
    if (!ids.length) return new Map();
    const own = await this.prisma.category.findMany({
      where: { id: { in: [...ids] } },
      select: { path: true },
    });
    const all = [...new Set(own.flatMap((c) => idsInPath(c.path)))];
    return this.byIds(all);
  }

  /** Ids of a subtree (the root included), by materialised path. */
  async subtreeIds(path: string): Promise<string[]> {
    const rows = await this.prisma.category.findMany({
      where: { OR: [{ path }, { path: { startsWith: `${path}/` } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async byIds(ids: readonly string[]): Promise<Map<string, CategoryNode>> {
    const rows = await this.prisma.category.findMany({
      where: { id: { in: [...ids] } },
      select: NODE_SELECT,
    });
    return new Map(
      rows.map(({ websites, ...c }) => [
        c.id,
        { ...c, websiteIds: websites.map((w) => w.websiteId) },
      ]),
    );
  }

  /** Every category visible in a website (active, assigned, all ancestors visible), localized. */
  async visible(
    websiteId: string,
    chain: readonly string[],
  ): Promise<Map<string, VisibleCategory>> {
    const rows = await this.prisma.category.findMany({
      where: { isActive: true, websites: { some: { websiteId } } },
      select: {
        ...NODE_SELECT,
        translations: {
          where: { localeCode: { in: [...chain] } },
          select: NODE_SELECT.translations.select,
        },
      },
      orderBy: [{ level: 'asc' }, { position: 'asc' }],
    });
    const out = new Map<string, VisibleCategory>();
    // Ordered by level, so a parent is decided before its children.
    for (const c of rows) {
      if (c.parentId && !out.has(c.parentId)) continue;
      const t = pickTranslation(c.translations, chain);
      if (!t) continue;
      out.set(c.id, {
        id: c.id,
        parentId: c.parentId,
        level: c.level,
        position: c.position,
        includeInMenu: c.includeInMenu,
        name: t.name,
        slug: t.slug,
        description: t.description,
        metaTitle: t.metaTitle,
        metaDescription: t.metaDescription,
      });
    }
    return out;
  }
}

/** Ids of `rootId` and its visible descendants. */
export function visibleSubtree(
  visible: ReadonlyMap<string, VisibleCategory>,
  rootId: string,
): string[] {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++)
    for (const c of visible.values()) if (c.parentId === ids[i]) ids.push(c.id);
  return ids;
}

/** Root → … → category, using only visible categories. */
export function breadcrumbs(
  visible: ReadonlyMap<string, VisibleCategory>,
  categoryId: string,
): VisibleCategory[] {
  const out: VisibleCategory[] = [];
  for (
    let c = visible.get(categoryId);
    c;
    c = c.parentId ? visible.get(c.parentId) : undefined
  )
    out.unshift(c);
  return out;
}
