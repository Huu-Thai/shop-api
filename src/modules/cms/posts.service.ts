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
import {
  assertUniqueLocales,
  resolveSlug,
} from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import {
  type ContentEventData,
  type ContentWriteInput,
  POST_EVENTS,
} from './cms.events.js';
import type {
  CreatePostDto,
  ListPostsQueryDto,
  PostDto,
  PostTranslationDto,
  UpdatePostDto,
} from './dto/post.dto.js';
import { sanitizeContent } from './html.js';

const SELECT = {
  id: true,
  storeId: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  authorId: true,
  featuredImageId: true,
  createdAt: true,
  updatedAt: true,
  tags: { select: { tagId: true } },
  translations: {
    select: {
      localeCode: true,
      title: true,
      slug: true,
      excerpt: true,
      content: true,
      metaTitle: true,
      metaDescription: true,
    },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.PostSelect;

type Row = Prisma.PostGetPayload<{ select: typeof SELECT }>;

const toDto = ({ tags, ...r }: Row, now = new Date()): PostDto => ({
  ...r,
  tagIds: tags.map((t) => t.tagId).sort(),
  visible: isVisible(r, now),
});

const normalize = (t: PostTranslationDto) => ({
  localeCode: t.localeCode,
  title: t.title,
  slug: resolveSlug(t.title, t.slug, `translations[${t.localeCode}]`),
  excerpt: t.excerpt?.trim() || null,
  content: sanitizeContent(t.content ?? ''),
  metaTitle: t.metaTitle?.trim() || null,
  metaDescription: t.metaDescription?.trim() || null,
});

const slugList = (x: Row) =>
  x.translations.map((t) => `${t.localeCode}:${t.slug}`);

/** Blog posts: like pages, plus excerpt, featured image, author and tags; URLs under `/blog/`. */
@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
  ) {}

  async list(q: ListPostsQueryDto): Promise<Paginated<PostDto>> {
    const where: Prisma.PostWhereInput = {
      storeId: q.storeId === 'global' ? null : q.storeId,
      status: q.status,
      ...(q.tagId ? { tags: { some: { tagId: q.tagId } } } : {}),
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
      this.prisma.post.findMany({
        where,
        select: SELECT,
        orderBy: [{ updatedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.post.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<PostDto> {
    const r = await this.prisma.post.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Post ${id} not found`);
    return toDto(r);
  }

  async create(dto: CreatePostDto, actor: Principal): Promise<PostDto> {
    if (!dto.translations.length)
      throw new BadRequestException('A post needs at least one translation');
    assertUniqueLocales(dto.translations);
    const translations = dto.translations.map(normalize);
    const storeId = dto.storeId ?? null;
    const tagIds = [...new Set(dto.tagIds ?? [])];
    return this.bus.write({
      before: new BeforeWriteEvent<ContentWriteInput>(
        POST_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { storeId, slugs: translations },
      ),
      work: async (tx, after) => {
        await assertFreeSlugs(tx, storeId, null, translations);
        await assertTags(tx, tagIds);
        const r = await tx.post.create({
          data: {
            storeId,
            featuredImageId: dto.featuredImageId ?? null,
            authorId: actor.type === 'admin' ? actor.id : null,
            translations: { create: translations },
            tags: { create: tagIds.map((tagId) => ({ tagId })) },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent<ContentEventData>(
            POST_EVENTS.CREATED,
            actorOf(actor),
            'post',
            r.id,
            { storeId, slugs: slugList(r), tagIds },
            { id: r.id, storeId, previousSlugs: [] },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdatePostDto,
    actor: Principal,
  ): Promise<PostDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    const translations = (dto.translations ?? []).map(normalize);
    const scope = await this.prisma.post.findUnique({
      where: { id },
      select: { storeId: true },
    });
    if (!scope) throw new NotFoundException(`Post ${id} not found`);
    return this.bus.write({
      before: new BeforeWriteEvent<ContentWriteInput>(
        POST_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { storeId: scope.storeId, slugs: translations },
      ),
      work: async (tx, after) => {
        const before = await tx.post.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Post ${id} not found`);
        await assertFreeSlugs(tx, before.storeId, id, translations);
        for (const t of translations)
          await tx.postTranslation.upsert({
            where: {
              postId_localeCode: { postId: id, localeCode: t.localeCode },
            },
            create: { postId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.postTranslation.deleteMany({
            where: { postId: id, localeCode: { in: dto.removeLocales } },
          });
        if (!(await tx.postTranslation.count({ where: { postId: id } })))
          throw new BadRequestException(
            'A post needs at least one translation',
          );
        if (dto.tagIds) {
          const tagIds = [...new Set(dto.tagIds)];
          await assertTags(tx, tagIds);
          await tx.postTag.deleteMany({
            where: { postId: id, tagId: { notIn: tagIds } },
          });
          await tx.postTag.createMany({
            data: tagIds.map((tagId) => ({ postId: id, tagId })),
            skipDuplicates: true,
          });
        }
        const r = await tx.post.update({
          where: { id },
          data: {
            featuredImageId: dto.featuredImageId,
            updatedAt: new Date(),
          },
          select: SELECT,
        });
        const a = toDto(before);
        const b = toDto(r);
        after.add(
          new EntityEvent<ContentEventData>(
            POST_EVENTS.UPDATED,
            actorOf(actor),
            'post',
            id,
            {
              ...(a.featuredImageId !== b.featuredImageId
                ? {
                    featuredImageId: {
                      from: a.featuredImageId,
                      to: b.featuredImageId,
                    },
                  }
                : {}),
              ...(a.tagIds.join() !== b.tagIds.join()
                ? { tagIds: { from: a.tagIds, to: b.tagIds } }
                : {}),
              ...(slugList(before).join() !== slugList(r).join()
                ? { slugs: { from: slugList(before), to: slugList(r) } }
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
        return b;
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        POST_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.post.findUnique({ where: { id }, select: SELECT });
        if (!r) throw new NotFoundException(`Post ${id} not found`);
        await tx.blockPlacement.deleteMany({
          where: { targetType: 'POST', targetId: id },
        });
        await tx.post.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'post', id);
        after.add(
          new EntityEvent<ContentEventData>(
            POST_EVENTS.DELETED,
            actorOf(actor),
            'post',
            id,
            { slugs: slugList(r) },
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
  ): Promise<PostDto> {
    await this.publisher.change(
      'post',
      id,
      POST_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }
}

async function assertFreeSlugs(
  tx: PrismaTransaction,
  storeId: string | null,
  selfId: string | null,
  slugs: readonly { localeCode: string; slug: string }[],
): Promise<void> {
  if (!slugs.length) return;
  const dup = await tx.postTranslation.findFirst({
    where: {
      OR: slugs.map((s) => ({ localeCode: s.localeCode, slug: s.slug })),
      post: { storeId, ...(selfId ? { id: { not: selfId } } : {}) },
    },
    select: { localeCode: true, slug: true },
  });
  if (dup)
    throw new ConflictException(
      `Another post already uses "${dup.slug}" (${dup.localeCode}) in this scope`,
    );
}

async function assertTags(
  tx: PrismaTransaction,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await tx.tag.count({ where: { id: { in: [...ids] } } });
  if (found !== ids.length)
    throw new BadRequestException('Unknown tag in tagIds');
}
