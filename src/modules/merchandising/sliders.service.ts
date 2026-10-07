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
import type { ListContentQueryDto } from '../cms/dto/page.dto.js';
import type {
  CreateSlideDto,
  CreateSliderDto,
  SlideDto,
  SliderDto,
  SlideTranslationDto,
  UpdateSlideDto,
  UpdateSliderDto,
} from './dto/merchandising.dto.js';
import { SLIDE_EVENTS, SLIDER_EVENTS } from './merchandising.events.js';

const SLIDE_SELECT = {
  id: true,
  imageId: true,
  position: true,
  linkUrl: true,
  isActive: true,
  translations: {
    select: { localeCode: true, title: true, caption: true, ctaLabel: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.SlideSelect;

const SELECT = {
  id: true,
  code: true,
  name: true,
  storeId: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  autoplayMs: true,
  createdAt: true,
  updatedAt: true,
  slides: {
    select: SLIDE_SELECT,
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.SliderSelect;

type Row = Prisma.SliderGetPayload<{ select: typeof SELECT }>;

const toDto = (r: Row, now = new Date()): SliderDto => ({
  ...r,
  visible: isVisible(r, now),
});

const normalize = (t: SlideTranslationDto) => ({
  localeCode: t.localeCode,
  title: t.title || null,
  caption: t.caption || null,
  ctaLabel: t.ctaLabel || null,
});

/** Sliders (carousels) by code; the slider is scheduled as a whole, slides switch on/off. */
@Injectable()
export class SlidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
  ) {}

  async list(q: ListContentQueryDto): Promise<Paginated<SliderDto>> {
    const where: Prisma.SliderWhereInput = {
      storeId: q.storeId === 'global' ? null : q.storeId,
      status: q.status,
      ...(q.search ? { code: { contains: q.search.toLowerCase() } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.slider.findMany({
        where,
        select: SELECT,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.slider.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<SliderDto> {
    const r = await this.prisma.slider.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Slider ${id} not found`);
    return toDto(r);
  }

  async create(dto: CreateSliderDto, actor: Principal): Promise<SliderDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        SLIDER_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const r = await tx.slider.create({
          data: {
            code: dto.code,
            name: dto.name,
            storeId: dto.storeId ?? null,
            autoplayMs: dto.autoplayMs ?? null,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            SLIDER_EVENTS.CREATED,
            actorOf(actor),
            'slider',
            r.id,
            { code: r.code, storeId: r.storeId },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateSliderDto,
    actor: Principal,
  ): Promise<SliderDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        SLIDER_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.slider.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Slider ${id} not found`);
        const r = await tx.slider.update({
          where: { id },
          data: { name: dto.name, autoplayMs: dto.autoplayMs },
          select: SELECT,
        });
        const changes = diff(before, r, ['name', 'autoplayMs']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              SLIDER_EVENTS.UPDATED,
              actorOf(actor),
              'slider',
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
        SLIDER_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.slider.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!r) throw new NotFoundException(`Slider ${id} not found`);
        await tx.slider.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'slider', id);
        after.add(
          new EntityEvent(
            SLIDER_EVENTS.DELETED,
            actorOf(actor),
            'slider',
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
  ): Promise<SliderDto> {
    await this.publisher.change(
      'slider',
      id,
      SLIDER_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }

  async addSlide(
    sliderId: string,
    dto: CreateSlideDto,
    actor: Principal,
  ): Promise<SlideDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        SLIDE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { sliderId, ...dto },
      ),
      work: async (tx, after) => {
        if (
          !(await tx.slider.findUnique({
            where: { id: sliderId },
            select: { id: true },
          }))
        )
          throw new NotFoundException(`Slider ${sliderId} not found`);
        const s = await tx.slide.create({
          data: {
            sliderId,
            imageId: dto.imageId ?? null,
            position: dto.position ?? 0,
            linkUrl: dto.linkUrl ?? null,
            isActive: dto.isActive ?? true,
            translations: { create: (dto.translations ?? []).map(normalize) },
          },
          select: SLIDE_SELECT,
        });
        after.add(
          new EntityEvent(SLIDE_EVENTS.CREATED, actorOf(actor), 'slide', s.id, {
            sliderId,
          }),
        );
        return s;
      },
    });
  }

  async updateSlide(
    id: string,
    dto: UpdateSlideDto,
    actor: Principal,
  ): Promise<SlideDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        SLIDE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.slide.findUnique({
          where: { id },
          select: SLIDE_SELECT,
        });
        if (!before) throw new NotFoundException(`Slide ${id} not found`);
        for (const t of (dto.translations ?? []).map(normalize))
          await tx.slideTranslation.upsert({
            where: {
              slideId_localeCode: { slideId: id, localeCode: t.localeCode },
            },
            create: { slideId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.slideTranslation.deleteMany({
            where: { slideId: id, localeCode: { in: dto.removeLocales } },
          });
        const s = await tx.slide.update({
          where: { id },
          data: {
            imageId: dto.imageId,
            position: dto.position,
            linkUrl: dto.linkUrl,
            isActive: dto.isActive,
          },
          select: SLIDE_SELECT,
        });
        const changes = diff(before, s, [
          'imageId',
          'position',
          'linkUrl',
          'isActive',
          'translations',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              SLIDE_EVENTS.UPDATED,
              actorOf(actor),
              'slide',
              id,
              changes,
            ),
          );
        return s;
      },
    });
  }

  async removeSlide(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        SLIDE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const s = await tx.slide.findUnique({
          where: { id },
          select: { sliderId: true },
        });
        if (!s) throw new NotFoundException(`Slide ${id} not found`);
        await tx.slide.delete({ where: { id } });
        after.add(
          new EntityEvent(SLIDE_EVENTS.DELETED, actorOf(actor), 'slide', id, s),
        );
      },
    });
  }
}
