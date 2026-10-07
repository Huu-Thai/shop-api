import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { PrismaService } from '../../database/prisma.service.js';
import { TAG_EVENTS } from './cms.events.js';
import type { CreateTagDto, TagDto, UpdateTagDto } from './dto/tag.dto.js';

const SELECT = {
  id: true,
  code: true,
  translations: {
    select: { localeCode: true, name: true },
    orderBy: { localeCode: 'asc' },
  },
} as const;

/** Blog tags (translated names; posts are filtered by tag code on the storefront). */
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  list(): Promise<TagDto[]> {
    return this.prisma.tag.findMany({
      select: SELECT,
      orderBy: { code: 'asc' },
    });
  }

  async create(dto: CreateTagDto, actor: Principal): Promise<TagDto> {
    assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAG_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const t = await tx.tag.create({
          data: { code: dto.code, translations: { create: dto.translations } },
          select: SELECT,
        });
        after.add(
          new EntityEvent(TAG_EVENTS.CREATED, actorOf(actor), 'tag', t.id, {
            code: t.code,
          }),
        );
        return t;
      },
    });
  }

  async update(
    id: string,
    dto: UpdateTagDto,
    actor: Principal,
  ): Promise<TagDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    return this.bus.write({
      before: new BeforeWriteEvent(
        TAG_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        if (!(await tx.tag.findUnique({ where: { id }, select: { id: true } })))
          throw new NotFoundException(`Tag ${id} not found`);
        for (const t of dto.translations ?? [])
          await tx.tagTranslation.upsert({
            where: {
              tagId_localeCode: { tagId: id, localeCode: t.localeCode },
            },
            create: { tagId: id, ...t },
            update: { name: t.name },
          });
        if (dto.removeLocales?.length)
          await tx.tagTranslation.deleteMany({
            where: { tagId: id, localeCode: { in: dto.removeLocales } },
          });
        if (!(await tx.tagTranslation.count({ where: { tagId: id } })))
          throw new BadRequestException('A tag needs at least one name');
        const t = await tx.tag.update({
          where: { id },
          data: { updatedAt: new Date() },
          select: SELECT,
        });
        after.add(
          new EntityEvent(TAG_EVENTS.UPDATED, actorOf(actor), 'tag', id, {
            translations: dto.translations?.map((x) => x.localeCode) ?? [],
            removedLocales: dto.removeLocales ?? [],
          }),
        );
        return t;
      },
    });
  }

  /** Removing a tag untags its posts. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        TAG_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const t = await tx.tag.findUnique({ where: { id }, select: SELECT });
        if (!t) throw new NotFoundException(`Tag ${id} not found`);
        await tx.tag.delete({ where: { id } });
        after.add(
          new EntityEvent(TAG_EVENTS.DELETED, actorOf(actor), 'tag', id, {
            code: t.code,
          }),
        );
      },
    });
  }
}
