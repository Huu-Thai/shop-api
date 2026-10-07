import { Injectable, NotFoundException } from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { isVisible } from '../../common/content/publishing.js';
import { diff } from '../../common/events/audited.event.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  BannerDto,
  BannerTranslationDto,
  CreateBannerDto,
  ListBannersQueryDto,
  UpdateBannerDto,
} from './dto/merchandising.dto.js';
import { BANNER_EVENTS } from './merchandising.events.js';

const SELECT = {
  id: true,
  placement: true,
  name: true,
  storeId: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  position: true,
  linkUrl: true,
  imageId: true,
  createdAt: true,
  updatedAt: true,
  translations: {
    select: {
      localeCode: true,
      title: true,
      subtitle: true,
      ctaLabel: true,
      imageId: true,
    },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.BannerSelect;

type Row = Prisma.BannerGetPayload<{ select: typeof SELECT }>;

const toDto = (r: Row, now = new Date()): BannerDto => ({
  ...r,
  visible: isVisible(r, now),
});

const normalize = (t: BannerTranslationDto) => ({
  localeCode: t.localeCode,
  title: t.title || null,
  subtitle: t.subtitle || null,
  ctaLabel: t.ctaLabel || null,
  imageId: t.imageId ?? null,
});

const FIELDS = ['placement', 'name', 'position', 'linkUrl', 'imageId'];

/** Banners: images with texts in a frontend placement (`home.hero`), shown on a schedule. */
@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
  ) {}

  async list(q: ListBannersQueryDto): Promise<Paginated<BannerDto>> {
    const where: Prisma.BannerWhereInput = {
      storeId: q.storeId === 'global' ? null : q.storeId,
      status: q.status,
      placement: q.placement,
      ...(q.search
        ? { name: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.banner.findMany({
        where,
        select: SELECT,
        orderBy: [{ placement: 'asc' }, { position: 'asc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.banner.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<BannerDto> {
    const r = await this.prisma.banner.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Banner ${id} not found`);
    return toDto(r);
  }

  async create(dto: CreateBannerDto, actor: Principal): Promise<BannerDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        BANNER_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const r = await tx.banner.create({
          data: {
            placement: dto.placement,
            name: dto.name,
            storeId: dto.storeId ?? null,
            position: dto.position ?? 0,
            linkUrl: dto.linkUrl ?? null,
            imageId: dto.imageId ?? null,
            translations: {
              create: (dto.translations ?? []).map(normalize),
            },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            BANNER_EVENTS.CREATED,
            actorOf(actor),
            'banner',
            r.id,
            { placement: r.placement, name: r.name, storeId: r.storeId },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateBannerDto,
    actor: Principal,
  ): Promise<BannerDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        BANNER_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.banner.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Banner ${id} not found`);
        for (const t of (dto.translations ?? []).map(normalize))
          await tx.bannerTranslation.upsert({
            where: {
              bannerId_localeCode: { bannerId: id, localeCode: t.localeCode },
            },
            create: { bannerId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.bannerTranslation.deleteMany({
            where: { bannerId: id, localeCode: { in: dto.removeLocales } },
          });
        const r = await tx.banner.update({
          where: { id },
          data: {
            placement: dto.placement,
            name: dto.name,
            position: dto.position,
            linkUrl: dto.linkUrl,
            imageId: dto.imageId,
            updatedAt: new Date(),
          },
          select: SELECT,
        });
        const changes = diff(before, r, [...FIELDS, 'translations']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              BANNER_EVENTS.UPDATED,
              actorOf(actor),
              'banner',
              id,
              changes,
            ),
          );
        return toDto(r);
      },
    });
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        BANNER_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.banner.findUnique({
          where: { id },
          select: { name: true, placement: true },
        });
        if (!r) throw new NotFoundException(`Banner ${id} not found`);
        await tx.banner.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'banner', id);
        after.add(
          new EntityEvent(
            BANNER_EVENTS.DELETED,
            actorOf(actor),
            'banner',
            id,
            r,
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
  ): Promise<BannerDto> {
    await this.publisher.change(
      'banner',
      id,
      BANNER_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }
}
