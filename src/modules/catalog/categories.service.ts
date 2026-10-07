import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import {
  assertUniqueLocales,
  resolveSlug,
} from '../../common/dto/translation.dto.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import {
  CATEGORY_EVENTS,
  type CategoryEventData,
  type CategoryWriteInput,
} from './catalog.events.js';
import { buildTree, isInSubtree, pathOf } from './category-tree.js';
import type {
  CategoryDto,
  CategoryNodeDto,
  CategoryTranslationDto,
  CreateCategoryDto,
  MoveCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto.js';

const SELECT = {
  id: true,
  parentId: true,
  path: true,
  level: true,
  position: true,
  isActive: true,
  includeInMenu: true,
  createdAt: true,
  updatedAt: true,
  translations: {
    select: {
      localeCode: true,
      name: true,
      slug: true,
      description: true,
      metaTitle: true,
      metaDescription: true,
    },
    orderBy: { localeCode: 'asc' },
  },
  websites: { select: { websiteId: true } },
} as const satisfies Prisma.CategorySelect;
type Row = Prisma.CategoryGetPayload<{ select: typeof SELECT }>;
const toDto = ({ websites, ...c }: Row): CategoryDto => ({
  ...c,
  websiteIds: websites.map((w) => w.websiteId).sort(),
});

export const MAX_CATEGORY_DEPTH = 10;

type Normalized = {
  localeCode: string;
  name: string;
  slug: string;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
};
const normalize = (t: CategoryTranslationDto): Normalized => ({
  localeCode: t.localeCode,
  name: t.name,
  slug: resolveSlug(t.name, t.slug, `translations[${t.localeCode}]`),
  description: t.description ?? null,
  metaTitle: t.metaTitle ?? null,
  metaDescription: t.metaDescription ?? null,
});

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(): Promise<CategoryDto[]> {
    return (
      await this.prisma.category.findMany({
        select: SELECT,
        orderBy: [{ level: 'asc' }, { position: 'asc' }],
      })
    ).map(toDto);
  }

  async tree(): Promise<CategoryNodeDto[]> {
    return buildTree(await this.list()) as CategoryNodeDto[];
  }

  async get(id: string): Promise<CategoryDto> {
    const c = await this.prisma.category.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!c) throw new NotFoundException(`Category ${id} not found`);
    return toDto(c);
  }

  async create(dto: CreateCategoryDto, actor: Principal): Promise<CategoryDto> {
    if (!dto.translations.length)
      throw new BadRequestException('At least one translation is required');
    assertUniqueLocales(dto.translations);
    const translations = dto.translations.map(normalize);
    const id = randomUUID();
    return this.bus.write({
      before: new BeforeWriteEvent<CategoryWriteInput>(
        CATEGORY_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        {
          parentId: dto.parentId ?? null,
          slugs: translations.map(({ localeCode, slug }) => ({
            localeCode,
            slug,
          })),
        },
      ),
      work: async (tx, after) => {
        const parent = dto.parentId
          ? await tx.category.findUnique({
              where: { id: dto.parentId },
              select: { path: true, level: true },
            })
          : null;
        if (dto.parentId && !parent)
          throw new BadRequestException(
            `Parent category ${dto.parentId} does not exist`,
          );
        if (parent && parent.level + 1 >= MAX_CATEGORY_DEPTH)
          throw new BadRequestException(
            `Categories nest at most ${MAX_CATEGORY_DEPTH} levels`,
          );
        await assertSiblingSlugs(tx, dto.parentId ?? null, id, translations);
        const path = pathOf(parent?.path ?? null, id);
        const c = await tx.category.create({
          data: {
            id,
            parentId: dto.parentId ?? null,
            path,
            level: parent ? parent.level + 1 : 0,
            position: dto.position ?? 0,
            isActive: dto.isActive ?? true,
            includeInMenu: dto.includeInMenu ?? true,
            translations: { create: translations },
            websites: {
              create: [...new Set(dto.websiteIds ?? [])].map((websiteId) => ({
                websiteId,
              })),
            },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent<CategoryEventData>(
            CATEGORY_EVENTS.CREATED,
            actorOf(actor),
            'category',
            id,
            {
              parentId: c.parentId,
              slugs: translations.map((t) => `${t.localeCode}:${t.slug}`),
            },
            { categoryId: id, path, urlsChanged: true },
          ),
        );
        return toDto(c);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
    actor: Principal,
  ): Promise<CategoryDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    const translations = (dto.translations ?? []).map(normalize);
    const current = await this.prisma.category.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!current) throw new NotFoundException(`Category ${id} not found`);
    return this.bus.write({
      before: new BeforeWriteEvent<CategoryWriteInput>(
        CATEGORY_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        {
          parentId: current.parentId,
          slugs: translations.map(({ localeCode, slug }) => ({
            localeCode,
            slug,
          })),
        },
      ),
      work: async (tx, after) => {
        const before = await tx.category.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Category ${id} not found`);
        await assertSiblingSlugs(tx, before.parentId, id, translations);
        for (const t of translations)
          await tx.categoryTranslation.upsert({
            where: {
              categoryId_localeCode: {
                categoryId: id,
                localeCode: t.localeCode,
              },
            },
            create: { categoryId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.categoryTranslation.deleteMany({
            where: { categoryId: id, localeCode: { in: dto.removeLocales } },
          });
        const remaining = await tx.categoryTranslation.count({
          where: { categoryId: id },
        });
        if (!remaining)
          throw new BadRequestException(
            'A category needs at least one translation',
          );
        const c = await tx.category.update({
          where: { id },
          data: {
            position: dto.position,
            isActive: dto.isActive,
            includeInMenu: dto.includeInMenu,
            ...(dto.websiteIds
              ? {
                  websites: {
                    deleteMany: {},
                    create: [...new Set(dto.websiteIds)].map((websiteId) => ({
                      websiteId,
                    })),
                  },
                }
              : {}),
          },
          select: SELECT,
        });
        const [b, a] = [toDto(before), toDto(c)];
        const changes = diff(b as never, a as never, [
          'position',
          'isActive',
          'includeInMenu',
          'translations',
          'websiteIds',
        ]);
        if (Object.keys(changes).length) {
          const slugsOf = (d: CategoryDto) =>
            d.translations.map((t) => `${t.localeCode}:${t.slug}`).join();
          const urlsChanged =
            slugsOf(b) !== slugsOf(a) ||
            b.websiteIds.join() !== a.websiteIds.join();
          after.add(
            new EntityEvent<CategoryEventData>(
              CATEGORY_EVENTS.UPDATED,
              actorOf(actor),
              'category',
              id,
              changes,
              { categoryId: id, path: a.path, urlsChanged },
            ),
          );
        }
        return a;
      },
    });
  }

  /** Re-parents a category and its whole subtree (paths and levels rewritten in one statement). */
  async move(
    id: string,
    dto: MoveCategoryDto,
    actor: Principal,
  ): Promise<CategoryDto> {
    return this.bus.write({
      before: new BeforeWriteEvent<CategoryWriteInput>(
        CATEGORY_EVENTS.BEFORE_WRITE,
        'move',
        id,
        actorOf(actor),
        { parentId: dto.parentId, slugs: [] },
      ),
      work: async (tx, after) => {
        const c = await tx.category.findUnique({
          where: { id },
          select: { ...SELECT },
        });
        if (!c) throw new NotFoundException(`Category ${id} not found`);
        const parent = dto.parentId
          ? await tx.category.findUnique({
              where: { id: dto.parentId },
              select: { path: true, level: true },
            })
          : null;
        if (dto.parentId && !parent)
          throw new BadRequestException(
            `Parent category ${dto.parentId} does not exist`,
          );
        if (parent && isInSubtree(parent.path, c.path))
          throw new BadRequestException(
            'A category cannot move into its own subtree',
          );
        const newPath = pathOf(parent?.path ?? null, id);
        const delta = (parent ? parent.level + 1 : 0) - c.level;
        const [{ depth }] = await tx.$queryRaw<{ depth: number }[]>`
          SELECT COALESCE(MAX(level), 0)::int AS depth FROM categories WHERE path = ${c.path} OR path LIKE ${`${c.path}/%`}`;
        if (depth + delta >= MAX_CATEGORY_DEPTH)
          throw new BadRequestException(
            `Categories nest at most ${MAX_CATEGORY_DEPTH} levels`,
          );
        await assertSiblingSlugs(tx, dto.parentId, id, c.translations);
        if (newPath !== c.path || delta)
          await tx.$executeRaw`
            UPDATE categories SET path = ${newPath} || substr(path, ${c.path.length + 1}), level = level + ${delta}, updated_at = now()
             WHERE path = ${c.path} OR path LIKE ${`${c.path}/%`}`;
        let moved = await tx.category.update({
          where: { id },
          data: {
            parentId: dto.parentId,
            position: dto.position ?? c.position,
          },
          select: SELECT,
        });
        // With a position, the category is inserted at that index among its new siblings, which
        // are renumbered 0…n (a drag and drop in the admin is one call).
        if (dto.position !== undefined) {
          const siblings = await tx.category.findMany({
            where: { parentId: dto.parentId, id: { not: id } },
            select: { id: true, position: true },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          });
          const order = siblings.map((x) => x.id);
          order.splice(Math.min(dto.position, order.length), 0, id);
          const current = new Map(siblings.map((x) => [x.id, x.position]));
          for (const [i, sid] of order.entries())
            if (sid !== id && current.get(sid) !== i)
              await tx.category.update({
                where: { id: sid },
                data: { position: i },
              });
          moved = await tx.category.update({
            where: { id },
            data: { position: order.indexOf(id) },
            select: SELECT,
          });
        }
        after.add(
          new EntityEvent<CategoryEventData>(
            CATEGORY_EVENTS.MOVED,
            actorOf(actor),
            'category',
            id,
            { parentId: { from: c.parentId, to: dto.parentId } },
            {
              categoryId: id,
              path: newPath,
              urlsChanged: c.parentId !== dto.parentId,
            },
          ),
        );
        return toDto(moved);
      },
    });
  }

  /** Only leaf categories can be deleted; product links cascade. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent<CategoryWriteInput>(
        CATEGORY_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
        { parentId: null, slugs: [] },
      ),
      work: async (tx, after) => {
        const c = await tx.category.findUnique({
          where: { id },
          select: { path: true, _count: { select: { children: true } } },
        });
        if (!c) throw new NotFoundException(`Category ${id} not found`);
        if (c._count.children)
          throw new ConflictException(
            `Category has ${c._count.children} subcategories; move or delete them first`,
          );
        await tx.category.delete({ where: { id } });
        after.add(
          new EntityEvent<CategoryEventData>(
            CATEGORY_EVENTS.DELETED,
            actorOf(actor),
            'category',
            id,
            undefined,
            { categoryId: id, path: c.path, urlsChanged: true },
          ),
        );
      },
    });
  }
}

/** Slugs are unique among siblings per locale (they form the URL path). */
async function assertSiblingSlugs(
  tx: PrismaTransaction,
  parentId: string | null,
  selfId: string,
  translations: readonly { localeCode: string; slug: string }[],
): Promise<void> {
  if (!translations.length) return;
  const clashes = await tx.categoryTranslation.findMany({
    where: {
      categoryId: { not: selfId },
      category: { parentId },
      OR: translations.map((t) => ({ localeCode: t.localeCode, slug: t.slug })),
    },
    select: { localeCode: true, slug: true },
  });
  if (clashes.length)
    throw new ConflictException(
      clashes.map(
        (c) =>
          `A sibling category already uses the slug "${c.slug}" in ${c.localeCode}`,
      ),
    );
}
