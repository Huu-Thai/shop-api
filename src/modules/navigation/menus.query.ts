import { Injectable } from '@nestjs/common';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import type { MenuLinkType } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import { CmsQuery } from '../cms/cms.query.js';
import { ProductsQuery } from '../products/products.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { UrlRewritesQuery } from '../url-rewrites/url-rewrites.query.js';
import type {
  StorefrontMenuDto,
  StorefrontMenuItemDto,
} from './dto/menu.dto.js';
import { buildVisibleTree, type TreeNode } from './menu-tree.js';

interface Resolved {
  url: string;
  title: string;
}

/**
 * Storefront menus: the store's own menu wins over the global one with the same code. Links are
 * resolved to canonical paths in the request's store and locale; links to hidden or missing
 * targets — and inactive items — are left out with their sub-items.
 */
@Injectable()
export class MenusQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cms: CmsQuery,
    private readonly categories: CategoriesQuery,
    private readonly products: ProductsQuery,
    private readonly urls: UrlRewritesQuery,
  ) {}

  async menu(
    ctx: StoreContext,
    code: string,
  ): Promise<StorefrontMenuDto | undefined> {
    const menus = await this.prisma.menu.findMany({
      where: { code, OR: [{ storeId: null }, { storeId: ctx.storeId }] },
      select: { id: true, code: true, name: true, storeId: true },
    });
    const menu = menus.find((m) => m.storeId) ?? menus[0];
    if (!menu) return undefined;
    const items = await this.prisma.menuItem.findMany({
      where: { menuId: menu.id },
      select: {
        id: true,
        parentId: true,
        position: true,
        linkType: true,
        targetId: true,
        url: true,
        openInNewTab: true,
        isActive: true,
        translations: {
          where: { localeCode: { in: ctx.localeChain } },
          select: { localeCode: true, label: true },
        },
      },
    });
    const links = await this.resolveLinks(
      ctx,
      items.filter((i) => i.isActive),
    );
    const view = items.map((i) => {
      const link =
        i.linkType === 'URL'
          ? undefined
          : links.get(`${i.linkType}:${i.targetId}`);
      return {
        ...i,
        url: i.linkType === 'URL' ? i.url : (link?.url ?? null),
        label:
          pickTranslation(i.translations, ctx.localeChain)?.label ??
          link?.title ??
          null,
      };
    });
    const tree = buildVisibleTree(
      view,
      (i) => i.isActive && !!i.url && !!i.label,
    );
    const toDto = (
      n: TreeNode<(typeof view)[number]>,
    ): StorefrontMenuItemDto => ({
      id: n.item.id,
      label: n.item.label!,
      url: n.item.url!,
      linkType: n.item.linkType,
      targetId: n.item.targetId,
      openInNewTab: n.item.openInNewTab,
      children: n.children.map(toDto),
    });
    return { code: menu.code, name: menu.name, items: tree.map(toDto) };
  }

  /** `TYPE:id` → site path and title, for visible targets only. */
  private async resolveLinks(
    ctx: StoreContext,
    items: readonly { linkType: MenuLinkType; targetId: string | null }[],
  ): Promise<Map<string, Resolved>> {
    const ids = (type: MenuLinkType) => [
      ...new Set(
        items
          .filter((i) => i.linkType === type && i.targetId)
          .map((i) => i.targetId!),
      ),
    ];
    const out = new Map<string, Resolved>();
    const add = (
      type: MenuLinkType,
      titles: ReadonlyMap<string, string>,
      paths: ReadonlyMap<string, string>,
    ) => {
      for (const [id, title] of titles) {
        const path = paths.get(id);
        if (path) out.set(`${type}:${id}`, { url: `/${path}`, title });
      }
    };
    const [pages, posts, categories, products] = [
      ids('PAGE'),
      ids('POST'),
      ids('CATEGORY'),
      ids('PRODUCT'),
    ];
    await Promise.all([
      (async () => {
        if (!pages.length) return;
        const [t, p] = await Promise.all([
          this.cms.visibleTitles(ctx, 'page', pages),
          this.urls.canonicalPaths(ctx, 'CMS_PAGE', pages),
        ]);
        add('PAGE', t, p);
      })(),
      (async () => {
        if (!posts.length) return;
        const [t, p] = await Promise.all([
          this.cms.visibleTitles(ctx, 'post', posts),
          this.urls.canonicalPaths(ctx, 'CMS_POST', posts),
        ]);
        add('POST', t, p);
      })(),
      (async () => {
        if (!categories.length) return;
        const [visible, p] = await Promise.all([
          this.categories.visible(ctx.websiteId, ctx.localeChain),
          this.urls.canonicalPaths(ctx, 'CATEGORY', categories),
        ]);
        add(
          'CATEGORY',
          new Map(
            categories
              .filter((id) => visible.has(id))
              .map((id) => [id, visible.get(id)!.name]),
          ),
          p,
        );
      })(),
      (async () => {
        if (!products.length) return;
        const shown = await this.products.visibleIds(ctx, products);
        const [summaries, p] = await Promise.all([
          this.products.summaries(ctx, shown),
          this.urls.canonicalPaths(ctx, 'PRODUCT', shown),
        ]);
        add('PRODUCT', new Map(summaries.map((s) => [s.id, s.name])), p);
      })(),
    ]);
    return out;
  }
}
