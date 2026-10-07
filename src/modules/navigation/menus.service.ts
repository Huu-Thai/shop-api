import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  actorOf,
  type Principal,
  SYSTEM_ACTOR,
} from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type {
  MenuLinkType,
  Prisma,
} from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import { CmsQuery } from '../cms/cms.query.js';
import { ProductsQuery } from '../products/products.query.js';
import type {
  CreateMenuDto,
  CreateMenuItemDto,
  MenuDetailDto,
  MenuDto,
  MenuItemDto,
  UpdateMenuDto,
  UpdateMenuItemDto,
} from './dto/menu.dto.js';
import { createsCycle, depthOf, treeOrder } from './menu-tree.js';
import { MENU_EVENTS, MENU_ITEM_EVENTS } from './navigation.events.js';

export const MAX_MENU_DEPTH = 5;

const MENU_SELECT = {
  id: true,
  code: true,
  name: true,
  storeId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ITEM_SELECT = {
  id: true,
  menuId: true,
  parentId: true,
  position: true,
  linkType: true,
  targetId: true,
  url: true,
  openInNewTab: true,
  isActive: true,
  translations: {
    select: { localeCode: true, label: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.MenuItemSelect;

type ItemRow = Prisma.MenuItemGetPayload<{ select: typeof ITEM_SELECT }>;

const toItem = ({ translations, menuId: _m, ...i }: ItemRow): MenuItemDto => ({
  ...i,
  labels: translations,
});

/** Navigation menus: trees of links to pages, posts, categories, products or URLs. */
@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly cms: CmsQuery,
    private readonly categories: CategoriesQuery,
    private readonly products: ProductsQuery,
  ) {}

  list(): Promise<MenuDto[]> {
    return this.prisma.menu.findMany({
      select: MENU_SELECT,
      orderBy: [{ code: 'asc' }, { storeId: 'asc' }],
    });
  }

  async get(id: string): Promise<MenuDetailDto> {
    const m = await this.prisma.menu.findUnique({
      where: { id },
      select: { ...MENU_SELECT, items: { select: ITEM_SELECT } },
    });
    if (!m) throw new NotFoundException(`Menu ${id} not found`);
    return { ...m, items: treeOrder(m.items).map(toItem) };
  }

  async create(dto: CreateMenuDto, actor: Principal): Promise<MenuDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        MENU_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const m = await tx.menu.create({
          data: {
            code: dto.code,
            name: dto.name,
            storeId: dto.storeId ?? null,
          },
          select: MENU_SELECT,
        });
        after.add(
          new EntityEvent(MENU_EVENTS.CREATED, actorOf(actor), 'menu', m.id, {
            code: m.code,
            storeId: m.storeId,
          }),
        );
        return m;
      },
    });
  }

  async update(
    id: string,
    dto: UpdateMenuDto,
    actor: Principal,
  ): Promise<MenuDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        MENU_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.menu.findUnique({
          where: { id },
          select: MENU_SELECT,
        });
        if (!before) throw new NotFoundException(`Menu ${id} not found`);
        const m = await tx.menu.update({
          where: { id },
          data: { name: dto.name },
          select: MENU_SELECT,
        });
        const changes = diff(before, m, ['name']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              MENU_EVENTS.UPDATED,
              actorOf(actor),
              'menu',
              id,
              changes,
            ),
          );
        return m;
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        MENU_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const m = await tx.menu.findUnique({
          where: { id },
          select: MENU_SELECT,
        });
        if (!m) throw new NotFoundException(`Menu ${id} not found`);
        await tx.menu.delete({ where: { id } });
        after.add(
          new EntityEvent(MENU_EVENTS.DELETED, actorOf(actor), 'menu', id, {
            code: m.code,
          }),
        );
      },
    });
  }

  async addItem(
    menuId: string,
    dto: CreateMenuItemDto,
    actor: Principal,
  ): Promise<MenuItemDto> {
    if (dto.labels) assertUniqueLocales(dto.labels, 'labels');
    const link = normalizeLink(dto.linkType, dto.targetId, dto.url);
    await this.assertTarget(link.linkType, link.targetId);
    return this.bus.write({
      before: new BeforeWriteEvent(
        MENU_ITEM_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { menuId, ...dto },
      ),
      work: async (tx, after) => {
        const parents = await this.parentsOf(tx, menuId);
        const parentId = dto.parentId ?? null;
        assertParent(parentId, parents);
        if (depthOf(parentId, parents) > MAX_MENU_DEPTH)
          throw new BadRequestException(
            `Menus are at most ${MAX_MENU_DEPTH} levels deep`,
          );
        const i = await tx.menuItem.create({
          data: {
            menuId,
            parentId,
            position: dto.position ?? 0,
            ...link,
            openInNewTab: dto.openInNewTab ?? false,
            isActive: dto.isActive ?? true,
            translations: { create: dto.labels ?? [] },
          },
          select: ITEM_SELECT,
        });
        after.add(
          new EntityEvent(
            MENU_ITEM_EVENTS.CREATED,
            actorOf(actor),
            'menu_item',
            i.id,
            { menuId, ...link },
          ),
        );
        return toItem(i);
      },
    });
  }

  async updateItem(
    id: string,
    dto: UpdateMenuItemDto,
    actor: Principal,
  ): Promise<MenuItemDto> {
    if (dto.labels) assertUniqueLocales(dto.labels, 'labels');
    const current = await this.prisma.menuItem.findUnique({
      where: { id },
      select: ITEM_SELECT,
    });
    if (!current) throw new NotFoundException(`Menu item ${id} not found`);
    const linkChanged =
      dto.linkType !== undefined ||
      dto.targetId !== undefined ||
      dto.url !== undefined;
    const linkType = dto.linkType ?? current.linkType;
    const link = linkChanged
      ? normalizeLink(
          linkType,
          dto.targetId ??
            (linkType === current.linkType ? current.targetId : undefined) ??
            undefined,
          dto.url ??
            (linkType === current.linkType ? current.url : undefined) ??
            undefined,
        )
      : undefined;
    if (link) await this.assertTarget(link.linkType, link.targetId);
    return this.bus.write({
      before: new BeforeWriteEvent(
        MENU_ITEM_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.menuItem.findUnique({
          where: { id },
          select: ITEM_SELECT,
        });
        if (!before) throw new NotFoundException(`Menu item ${id} not found`);
        if (dto.parentId !== undefined) {
          const parents = await this.parentsOf(tx, before.menuId);
          assertParent(dto.parentId, parents);
          if (createsCycle(id, dto.parentId, parents))
            throw new BadRequestException(
              'An item cannot move under itself or its descendants',
            );
          const subtree = subtreeDepth(id, parents);
          if (depthOf(dto.parentId, parents) + subtree - 1 > MAX_MENU_DEPTH)
            throw new BadRequestException(
              `Menus are at most ${MAX_MENU_DEPTH} levels deep`,
            );
        }
        for (const l of dto.labels ?? [])
          await tx.menuItemTranslation.upsert({
            where: {
              itemId_localeCode: { itemId: id, localeCode: l.localeCode },
            },
            create: { itemId: id, ...l },
            update: { label: l.label },
          });
        if (dto.removeLocales?.length)
          await tx.menuItemTranslation.deleteMany({
            where: { itemId: id, localeCode: { in: dto.removeLocales } },
          });
        const i = await tx.menuItem.update({
          where: { id },
          data: {
            parentId: dto.parentId,
            position: dto.position,
            openInNewTab: dto.openInNewTab,
            isActive: dto.isActive,
            ...link,
          },
          select: ITEM_SELECT,
        });
        const changes = diff(before, i, [
          'parentId',
          'position',
          'linkType',
          'targetId',
          'url',
          'openInNewTab',
          'isActive',
          'translations',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              MENU_ITEM_EVENTS.UPDATED,
              actorOf(actor),
              'menu_item',
              id,
              changes,
            ),
          );
        return toItem(i);
      },
    });
  }

  /** Removes an item and its children. */
  async removeItem(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        MENU_ITEM_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const i = await tx.menuItem.findUnique({
          where: { id },
          select: { menuId: true },
        });
        if (!i) throw new NotFoundException(`Menu item ${id} not found`);
        await tx.menuItem.delete({ where: { id } });
        after.add(
          new EntityEvent(
            MENU_ITEM_EVENTS.DELETED,
            actorOf(actor),
            'menu_item',
            id,
            { menuId: i.menuId },
          ),
        );
      },
    });
  }

  /** A linked page, post or category was deleted: its items are deactivated (kept for editors). */
  async deactivateLinksTo(
    linkType: MenuLinkType,
    targetId: string,
  ): Promise<number> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        MENU_ITEM_EVENTS.BEFORE_WRITE,
        'deactivate',
        targetId,
        SYSTEM_ACTOR,
        { linkType },
      ),
      work: async (tx, after) => {
        const items = await tx.menuItem.findMany({
          where: { linkType, targetId, isActive: true },
          select: { id: true },
        });
        if (!items.length) return 0;
        await tx.menuItem.updateMany({
          where: { id: { in: items.map((i) => i.id) } },
          data: { isActive: false },
        });
        for (const i of items)
          after.add(
            new EntityEvent(
              MENU_ITEM_EVENTS.UPDATED,
              SYSTEM_ACTOR,
              'menu_item',
              i.id,
              {
                isActive: { from: true, to: false },
                reason: `${linkType.toLowerCase()} deleted`,
              },
            ),
          );
        return items.length;
      },
    });
  }

  private async parentsOf(
    tx: PrismaTransaction,
    menuId: string,
  ): Promise<Map<string, string | null>> {
    if (
      !(await tx.menu.findUnique({
        where: { id: menuId },
        select: { id: true },
      }))
    )
      throw new NotFoundException(`Menu ${menuId} not found`);
    const rows = await tx.menuItem.findMany({
      where: { menuId },
      select: { id: true, parentId: true },
    });
    return new Map(rows.map((r) => [r.id, r.parentId]));
  }

  private async assertTarget(
    type: MenuLinkType,
    id: string | null,
  ): Promise<void> {
    if (type === 'URL' || !id) return;
    const exists =
      type === 'PAGE' || type === 'POST'
        ? (
            await this.cms.existing(type === 'PAGE' ? 'page' : 'post', [id])
          ).has(id)
        : type === 'CATEGORY'
          ? (await this.categories.byIds([id])).has(id)
          : (await this.products.existing([id])).has(id);
    if (!exists)
      throw new BadRequestException(
        `${type.toLowerCase()} ${id} does not exist`,
      );
  }
}

/** URL links carry a URL, the others a target id (ck_menu_items_link). */
export function normalizeLink(
  linkType: MenuLinkType,
  targetId: string | undefined,
  url: string | undefined,
): { linkType: MenuLinkType; targetId: string | null; url: string | null } {
  if (linkType === 'URL') {
    if (!url) throw new BadRequestException('A URL link needs a url');
    return { linkType, targetId: null, url };
  }
  if (!targetId)
    throw new BadRequestException(
      `A ${linkType.toLowerCase()} link needs a targetId`,
    );
  return { linkType, targetId, url: null };
}

function assertParent(
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): void {
  if (parentId && !parents.has(parentId))
    throw new BadRequestException('The parent item is not in this menu');
}

/** Levels in the subtree rooted at `id` (1 = no children). */
function subtreeDepth(
  id: string,
  parents: ReadonlyMap<string, string | null>,
): number {
  let max = 1;
  for (const child of parents.keys()) {
    let d = 1;
    for (let p = parents.get(child) ?? null; p; p = parents.get(p) ?? null) {
      d++;
      if (p === id) {
        max = Math.max(max, d);
        break;
      }
    }
  }
  return max;
}
