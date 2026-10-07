import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { isVisible } from '../../common/content/publishing.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { slugify } from '../../common/i18n/slug.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import {
  type ContentEventData,
  type ContentWriteInput,
  PAGE_EVENTS,
} from './cms.events.js';
import { PAGE_SLUG_PATTERN } from './dto/common.js';
import type {
  CreatePageDto,
  ListContentQueryDto,
  PageDto,
  PageTranslationDto,
  UpdatePageDto,
} from './dto/page.dto.js';
import { sanitizeContent } from './html.js';

const SELECT = {
  id: true,
  storeId: true,
  status: true,
  layout: true,
  publishedAt: true,
  unpublishedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  translations: {
    select: {
      localeCode: true,
      title: true,
      slug: true,
      content: true,
      metaTitle: true,
      metaDescription: true,
    },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.PageSelect;

type Row = Prisma.PageGetPayload<{ select: typeof SELECT }>;

export const toPageDto = (r: Row, now = new Date()): PageDto => ({
  ...r,
  visible: isVisible(r, now),
});

/** Explicit page slug (validated, segments allowed) or one derived from the title. */
export function pageSlug(
  title: string,
  slug: string | undefined,
  where: string,
) {
  const s = (slug?.trim() || slugify(title)).replace(/^\/+|\/+$/g, '');
  if (!s)
    throw new BadRequestException(
      `${where}: cannot derive a URL key from "${title}"; send a slug`,
    );
  if (!PAGE_SLUG_PATTERN.test(s) || s.length > 255)
    throw new BadRequestException(
      `${where}: slug must be lower-case words joined by "-", with optional "/" segments`,
    );
  return s;
}

const normalize = (t: PageTranslationDto) => ({
  localeCode: t.localeCode,
  title: t.title,
  slug: pageSlug(t.title, t.slug, `translations[${t.localeCode}]`),
  content: sanitizeContent(t.content ?? ''),
  metaTitle: t.metaTitle?.trim() || null,
  metaDescription: t.metaDescription?.trim() || null,
});

/** CMS pages (PLAN.md §9 & §14 Phase 4): translated, sanitized HTML, global or per store, published on schedule. */
@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
  ) {}

  async list(q: ListContentQueryDto): Promise<Paginated<PageDto>> {
    const where: Prisma.PageWhereInput = {
      storeId: q.storeId === 'global' ? null : q.storeId,
      status: q.status,
      ...(q.search
        ? {
            translations: {
              some: {
                OR: [
                  { title: { contains: q.search, mode: 'insensitive' } },
                  { slug: { contains: q.search.toLowerCase() } },
                ],
              },
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.page.findMany({
        where,
        select: SELECT,
        orderBy: [{ updatedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.page.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toPageDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<PageDto> {
    const r = await this.prisma.page.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Page ${id} not found`);
    return toPageDto(r);
  }

  async create(dto: CreatePageDto, actor: Principal): Promise<PageDto> {
    if (!dto.translations.length)
      throw new BadRequestException('A page needs at least one translation');
    assertUniqueLocales(dto.translations);
    const translations = dto.translations.map(normalize);
    const storeId = dto.storeId ?? null;
    return this.bus.write({
      before: new BeforeWriteEvent<ContentWriteInput>(
        PAGE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { storeId, slugs: translations },
      ),
      work: async (tx, after) => {
        await assertFreeSlugs(tx, storeId, null, translations);
        const r = await tx.page.create({
          data: {
            storeId,
            layout: dto.layout ?? 'default',
            createdById: actor.type === 'admin' ? actor.id : null,
            translations: { create: translations },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent<ContentEventData>(
            PAGE_EVENTS.CREATED,
            actorOf(actor),
            'page',
            r.id,
            {
              storeId,
              slugs: translations.map((t) => `${t.localeCode}:${t.slug}`),
            },
            { id: r.id, storeId, previousSlugs: [] },
          ),
        );
        return toPageDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdatePageDto,
    actor: Principal,
  ): Promise<PageDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    const translations = (dto.translations ?? []).map(normalize);
    // The scope never changes, so the URL veto can be told it up front.
    const scope = await this.prisma.page.findUnique({
      where: { id },
      select: { storeId: true },
    });
    if (!scope) throw new NotFoundException(`Page ${id} not found`);
    return this.bus.write({
      before: new BeforeWriteEvent<ContentWriteInput>(
        PAGE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { storeId: scope.storeId, slugs: translations },
      ),
      work: async (tx, after) => {
        const before = await tx.page.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Page ${id} not found`);
        await assertFreeSlugs(tx, before.storeId, id, translations);
        for (const t of translations)
          await tx.pageTranslation.upsert({
            where: {
              pageId_localeCode: { pageId: id, localeCode: t.localeCode },
            },
            create: { pageId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.pageTranslation.deleteMany({
            where: { pageId: id, localeCode: { in: dto.removeLocales } },
          });
        if (!(await tx.pageTranslation.count({ where: { pageId: id } })))
          throw new BadRequestException(
            'A page needs at least one translation',
          );
        const r = await tx.page.update({
          where: { id },
          data: { layout: dto.layout, updatedAt: new Date() },
          select: SELECT,
        });
        const slugs = (x: Row) =>
          x.translations.map((t) => `${t.localeCode}:${t.slug}`);
        after.add(
          new EntityEvent<ContentEventData>(
            PAGE_EVENTS.UPDATED,
            actorOf(actor),
            'page',
            id,
            {
              ...(before.layout !== r.layout
                ? { layout: { from: before.layout, to: r.layout } }
                : {}),
              ...(slugs(before).join() !== slugs(r).join()
                ? { slugs: { from: slugs(before), to: slugs(r) } }
                : {}),
              ...(translations.length
                ? { translations: translations.map((t) => t.localeCode) }
                : {}),
              ...(dto.removeLocales?.length
                ? { removedLocales: dto.removeLocales }
                : {}),
            },
            {
              id,
              storeId: r.storeId,
              previousSlugs: before.translations.map((t) => t.slug),
            },
          ),
        );
        return toPageDto(r);
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        PAGE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.page.findUnique({ where: { id }, select: SELECT });
        if (!r) throw new NotFoundException(`Page ${id} not found`);
        await tx.blockPlacement.deleteMany({
          where: { targetType: 'PAGE', targetId: id },
        });
        await tx.page.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'page', id);
        after.add(
          new EntityEvent<ContentEventData>(
            PAGE_EVENTS.DELETED,
            actorOf(actor),
            'page',
            id,
            { slugs: r.translations.map((t) => `${t.localeCode}:${t.slug}`) },
            {
              id,
              storeId: r.storeId,
              previousSlugs: r.translations.map((t) => t.slug),
            },
          ),
        );
      },
    });
  }

  async publish(
    id: string,
    action: 'publish' | 'unpublish',
    at: string | undefined,
    actor: Principal,
  ): Promise<PageDto> {
    await this.publisher.change(
      'page',
      id,
      PAGE_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }
}

/** Slugs are unique per scope (global, or one store) and locale; a store page may shadow a global one. */
async function assertFreeSlugs(
  tx: PrismaTransaction,
  storeId: string | null,
  selfId: string | null,
  slugs: readonly { localeCode: string; slug: string }[],
): Promise<void> {
  if (!slugs.length) return;
  const dup = await tx.pageTranslation.findFirst({
    where: {
      OR: slugs.map((s) => ({ localeCode: s.localeCode, slug: s.slug })),
      page: { storeId, ...(selfId ? { id: { not: selfId } } : {}) },
    },
    select: { localeCode: true, slug: true },
  });
  if (dup)
    throw new ConflictException(
      `Another page already uses "${dup.slug}" (${dup.localeCode}) in this scope`,
    );
}
