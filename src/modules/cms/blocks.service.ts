import {
  BadRequestException,
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
import type {
  BlockTargetType,
  Prisma,
} from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import { ProductsQuery } from '../products/products.query.js';
import {
  BLOCK_EVENTS,
  BLOCK_PLACEMENT_EVENTS,
  type PlacementEventData,
} from './cms.events.js';
import type {
  BlockDto,
  BlockTranslationDto,
  CreateBlockDto,
  CreatePlacementDto,
  PlacementDto,
  UpdateBlockDto,
} from './dto/block.dto.js';
import type { ListContentQueryDto } from './dto/page.dto.js';
import { sanitizeContent } from './html.js';

const SELECT = {
  id: true,
  identifier: true,
  storeId: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  createdAt: true,
  updatedAt: true,
  translations: {
    select: { localeCode: true, title: true, content: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.BlockSelect;

const PLACEMENT_SELECT = {
  id: true,
  blockId: true,
  targetType: true,
  targetId: true,
  region: true,
  position: true,
} as const;

type Row = Prisma.BlockGetPayload<{ select: typeof SELECT }>;

const toDto = (r: Row, now = new Date()): BlockDto => ({
  ...r,
  visible: isVisible(r, now),
});

const normalize = (t: BlockTranslationDto) => ({
  localeCode: t.localeCode,
  title: t.title?.trim() || null,
  content: sanitizeContent(t.content),
});

/**
 * Blocks: reusable snippets embedded in content with `{{block id="…"}}` or placed in regions of
 * pages, posts, categories and products. A store block overrides the global one with its identifier.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
    private readonly categories: CategoriesQuery,
    private readonly products: ProductsQuery,
  ) {}

  async list(q: ListContentQueryDto): Promise<Paginated<BlockDto>> {
    const where: Prisma.BlockWhereInput = {
      storeId: q.storeId === 'global' ? null : q.storeId,
      status: q.status,
      ...(q.search ? { identifier: { contains: q.search.toLowerCase() } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.block.findMany({
        where,
        select: SELECT,
        orderBy: [{ updatedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.block.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<BlockDto> {
    const r = await this.prisma.block.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Block ${id} not found`);
    return toDto(r);
  }

  async create(dto: CreateBlockDto, actor: Principal): Promise<BlockDto> {
    if (!dto.translations.length)
      throw new BadRequestException('A block needs at least one translation');
    assertUniqueLocales(dto.translations);
    const translations = dto.translations.map(normalize);
    return this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { identifier: dto.identifier, storeId: dto.storeId ?? null },
      ),
      work: async (tx, after) => {
        const r = await tx.block.create({
          data: {
            identifier: dto.identifier,
            storeId: dto.storeId ?? null,
            translations: { create: translations },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            BLOCK_EVENTS.CREATED,
            actorOf(actor),
            'block',
            r.id,
            { identifier: r.identifier, storeId: r.storeId },
            { id: r.id, identifier: r.identifier, storeId: r.storeId },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateBlockDto,
    actor: Principal,
  ): Promise<BlockDto> {
    if (dto.translations) assertUniqueLocales(dto.translations);
    const translations = (dto.translations ?? []).map(normalize);
    return this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        if (
          !(await tx.block.findUnique({ where: { id }, select: { id: true } }))
        )
          throw new NotFoundException(`Block ${id} not found`);
        for (const t of translations)
          await tx.blockTranslation.upsert({
            where: {
              blockId_localeCode: { blockId: id, localeCode: t.localeCode },
            },
            create: { blockId: id, ...t },
            update: t,
          });
        if (dto.removeLocales?.length)
          await tx.blockTranslation.deleteMany({
            where: { blockId: id, localeCode: { in: dto.removeLocales } },
          });
        if (!(await tx.blockTranslation.count({ where: { blockId: id } })))
          throw new BadRequestException(
            'A block needs at least one translation',
          );
        const r = await tx.block.update({
          where: { id },
          data: { updatedAt: new Date() },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            BLOCK_EVENTS.UPDATED,
            actorOf(actor),
            'block',
            id,
            {
              translations: translations.map((t) => t.localeCode),
              removedLocales: dto.removeLocales ?? [],
            },
            { id, identifier: r.identifier, storeId: r.storeId },
          ),
        );
        return toDto(r);
      },
    });
  }

  /** Deleting a block removes its placements; `{{block}}` tokens referring to it render nothing. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.block.findUnique({
          where: { id },
          select: { identifier: true, storeId: true },
        });
        if (!r) throw new NotFoundException(`Block ${id} not found`);
        await tx.block.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'block', id);
        after.add(
          new EntityEvent(
            BLOCK_EVENTS.DELETED,
            actorOf(actor),
            'block',
            id,
            { identifier: r.identifier },
            { id, ...r },
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
  ): Promise<BlockDto> {
    await this.publisher.change(
      'block',
      id,
      BLOCK_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }

  async placements(blockId: string): Promise<PlacementDto[]> {
    await this.get(blockId);
    return this.prisma.blockPlacement.findMany({
      where: { blockId },
      select: PLACEMENT_SELECT,
      orderBy: [{ targetType: 'asc' }, { region: 'asc' }, { position: 'asc' }],
    });
  }

  /** Places a block in a region of a page, post, category or product (the target must exist). */
  async addPlacement(
    blockId: string,
    dto: CreatePlacementDto,
    actor: Principal,
  ): Promise<PlacementDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_PLACEMENT_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { blockId, ...dto },
      ),
      work: async (tx, after) => {
        if (
          !(await tx.block.findUnique({
            where: { id: blockId },
            select: { id: true },
          }))
        )
          throw new NotFoundException(`Block ${blockId} not found`);
        if (!(await this.targetExists(tx, dto.targetType, dto.targetId)))
          throw new BadRequestException(
            `${dto.targetType.toLowerCase()} ${dto.targetId} does not exist`,
          );
        const p = await tx.blockPlacement.create({
          data: {
            blockId,
            targetType: dto.targetType,
            targetId: dto.targetId,
            region: dto.region,
            position: dto.position ?? 0,
          },
          select: PLACEMENT_SELECT,
        });
        after.add(
          new EntityEvent<PlacementEventData>(
            BLOCK_PLACEMENT_EVENTS.CREATED,
            actorOf(actor),
            'block_placement',
            p.id,
            { ...dto },
            {
              blockId,
              targetType: p.targetType,
              targetId: p.targetId,
              region: p.region,
            },
          ),
        );
        return p;
      },
    });
  }

  async removePlacement(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_PLACEMENT_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const p = await tx.blockPlacement.findUnique({
          where: { id },
          select: PLACEMENT_SELECT,
        });
        if (!p) throw new NotFoundException(`Placement ${id} not found`);
        await tx.blockPlacement.delete({ where: { id } });
        after.add(
          new EntityEvent<PlacementEventData>(
            BLOCK_PLACEMENT_EVENTS.DELETED,
            actorOf(actor),
            'block_placement',
            id,
            { region: p.region, targetType: p.targetType },
            {
              blockId: p.blockId,
              targetType: p.targetType,
              targetId: p.targetId,
              region: p.region,
            },
          ),
        );
      },
    });
  }

  /** Placements of a deleted catalog target (category/product) — after-event cleanup. */
  async removePlacementsOf(
    targetType: BlockTargetType,
    targetId: string,
  ): Promise<number> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        BLOCK_PLACEMENT_EVENTS.BEFORE_WRITE,
        'cleanup',
        targetId,
        actorOf(undefined),
        { targetType },
      ),
      work: async (tx) =>
        (
          await tx.blockPlacement.deleteMany({
            where: { targetType, targetId },
          })
        ).count,
    });
  }

  private async targetExists(
    tx: PrismaTransaction,
    type: BlockTargetType,
    id: string,
  ): Promise<boolean> {
    switch (type) {
      case 'PAGE':
        return !!(await tx.page.findUnique({
          where: { id },
          select: { id: true },
        }));
      case 'POST':
        return !!(await tx.post.findUnique({
          where: { id },
          select: { id: true },
        }));
      case 'CATEGORY':
        return (await this.categories.byIds([id])).has(id);
      case 'PRODUCT':
        return (await this.products.existing([id])).has(id);
    }
  }
}
