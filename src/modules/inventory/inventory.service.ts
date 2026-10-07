import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ProductsQuery } from '../products/products.query.js';
import { salableOf } from './allocation.js';
import type {
  CreateInventorySourceDto,
  InventorySourceDto,
  ListMovementsQueryDto,
  ListStockQueryDto,
  MovementDto,
  SetWebsiteSourcesDto,
  StockAdjustmentDto,
  StockDto,
  UpdateInventorySourceDto,
  WebsiteSourceDto,
} from './dto/inventory.dto.js';
import {
  INVENTORY_EVENTS,
  INVENTORY_SOURCE_EVENTS,
  type InventoryChangedData,
} from './inventory.events.js';
import { UNMANAGED_TYPES } from './inventory.query.js';

const SOURCE = {
  id: true,
  code: true,
  name: true,
  countryCode: true,
  isActive: true,
} as const;

/** Sources, their websites, stock levels and the ledger (admin). */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly products: ProductsQuery,
  ) {}

  sources(): Promise<InventorySourceDto[]> {
    return this.prisma.inventorySource.findMany({
      select: SOURCE,
      orderBy: { code: 'asc' },
    });
  }

  createSource(
    dto: CreateInventorySourceDto,
    actor: Principal,
  ): Promise<InventorySourceDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_SOURCE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const s = await tx.inventorySource.create({
          data: dto,
          select: SOURCE,
        });
        after.add(
          new EntityEvent(
            INVENTORY_SOURCE_EVENTS.CREATED,
            actorOf(actor),
            'inventory_source',
            s.id,
            { ...dto },
          ),
        );
        return s;
      },
    });
  }

  /** Deactivating a source removes its stock from every website's salable quantity. */
  updateSource(
    id: string,
    dto: UpdateInventorySourceDto,
    actor: Principal,
  ): Promise<InventorySourceDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_SOURCE_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.inventorySource.findUnique({
          where: { id },
          select: SOURCE,
        });
        if (!before)
          throw new NotFoundException(`Inventory source ${id} not found`);
        const s = await tx.inventorySource.update({
          where: { id },
          data: dto,
          select: SOURCE,
        });
        const changes = diff(before, s, ['name', 'isActive']);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              INVENTORY_SOURCE_EVENTS.UPDATED,
              actorOf(actor),
              'inventory_source',
              id,
              changes,
            ),
          );
        if ('isActive' in changes)
          after.add(
            new ProjectionEvent<InventoryChangedData>(
              INVENTORY_EVENTS.CHANGED,
              { variantIds: await variantsAt(tx, [id]) },
            ),
          );
        return s;
      },
    });
  }

  async websiteSources(websiteId: string): Promise<WebsiteSourceDto[]> {
    const rows = await this.prisma.websiteInventorySource.findMany({
      where: { websiteId },
      select: {
        sourceId: true,
        priority: true,
        source: { select: { code: true } },
      },
      orderBy: { priority: 'asc' },
    });
    return rows.map((r) => ({
      sourceId: r.sourceId,
      code: r.source.code,
      priority: r.priority,
    }));
  }

  async setWebsiteSources(
    websiteId: string,
    dto: SetWebsiteSourcesDto,
    actor: Principal,
  ): Promise<WebsiteSourceDto[]> {
    const ids = dto.sources.map((s) => s.sourceId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('A source is listed twice');
    await this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_EVENTS.BEFORE_WRITE,
        'website-sources',
        websiteId,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const previous = await tx.websiteInventorySource.findMany({
          where: { websiteId },
          select: { sourceId: true },
        });
        await tx.websiteInventorySource.deleteMany({ where: { websiteId } });
        await tx.websiteInventorySource.createMany({
          data: dto.sources.map((s, i) => ({
            websiteId,
            sourceId: s.sourceId,
            priority: s.priority ?? i,
          })),
        });
        after.add(
          new EntityEvent(
            INVENTORY_EVENTS.WEBSITE_SOURCES_CHANGED,
            actorOf(actor),
            'website',
            websiteId,
            { sources: dto.sources },
          ),
        );
        const touched = [
          ...new Set([...ids, ...previous.map((p) => p.sourceId)]),
        ];
        after.add(
          new ProjectionEvent<InventoryChangedData>(INVENTORY_EVENTS.CHANGED, {
            variantIds: await variantsAt(tx, touched),
          }),
        );
      },
    });
    return this.websiteSources(websiteId);
  }

  async stock(q: ListStockQueryDto): Promise<Paginated<StockDto>> {
    const where: Prisma.InventoryWhereInput = {
      sourceId: q.sourceId,
      variantId: q.variantId,
      ...(q.sku || q.productId || q.search
        ? {
            variant: {
              ...(q.sku ? { sku: q.sku } : {}),
              ...(q.search
                ? { sku: { contains: q.search, mode: 'insensitive' as const } }
                : {}),
              productId: q.productId,
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        select: {
          sourceId: true,
          variantId: true,
          quantity: true,
          reserved: true,
          safetyStock: true,
          version: true,
          source: { select: { code: true } },
          variant: { select: { sku: true } },
        },
        orderBy: [{ variant: { sku: 'asc' } }, { source: { code: 'asc' } }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.inventory.count({ where }),
    ]);
    return paginated(
      rows.map(({ source, variant, ...r }) => ({
        ...r,
        sourceCode: source.code,
        sku: variant.sku,
        salable: salableOf(r),
      })),
      total,
      q,
    );
  }

  /**
   * Receipt, shrinkage or recount for one variant at one source. Writes the ledger and locks the
   * stock row, so concurrent reservations and adjustments serialise; can't go below reserved.
   */
  async adjust(dto: StockAdjustmentDto, actor: Principal): Promise<StockDto> {
    if (dto.delta !== undefined && dto.quantity !== undefined)
      throw new BadRequestException('Send delta or quantity, not both');
    if (
      dto.delta === undefined &&
      dto.quantity === undefined &&
      dto.safetyStock === undefined
    )
      throw new BadRequestException(
        'Send delta or quantity (or only safetyStock)',
      );
    const variantId =
      dto.variantId ??
      (dto.sku
        ? (await this.products.variantIdsBySku([dto.sku])).get(dto.sku)
        : undefined);
    if (!variantId)
      throw new BadRequestException(
        dto.sku ? `Unknown SKU ${dto.sku}` : 'variantId or sku is required',
      );
    const info = (await this.products.variantTaxInfo([variantId])).get(
      variantId,
    );
    if (!info)
      throw new BadRequestException(`Variant ${variantId} does not exist`);
    if (UNMANAGED_TYPES.has(info.type))
      throw new BadRequestException(`${info.type} products don't keep stock`);

    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_EVENTS.BEFORE_WRITE,
        'adjust',
        variantId,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        await tx.inventory.upsert({
          where: { sourceId_variantId: { sourceId: dto.sourceId, variantId } },
          create: { sourceId: dto.sourceId, variantId },
          update: {},
        });
        const [row] = await tx.$queryRaw<
          {
            id: string;
            quantity: number;
            reserved: number;
            safety_stock: number;
            version: number;
          }[]
        >`
          SELECT id, quantity, reserved, safety_stock, version FROM inventories
           WHERE source_id = ${dto.sourceId}::uuid AND variant_id = ${variantId}::uuid FOR UPDATE`;
        if (
          dto.expectedVersion !== undefined &&
          dto.expectedVersion !== row.version
        )
          throw new ConflictException(
            `Stock changed meanwhile (version ${row.version}, expected ${dto.expectedVersion}); reload and retry`,
          );
        const quantity = dto.quantity ?? row.quantity + (dto.delta ?? 0);
        if (quantity < row.reserved)
          throw new ConflictException(
            `Quantity can't go below the ${row.reserved} unit(s) reserved`,
          );
        if (quantity < 0)
          throw new ConflictException('Quantity would become negative');
        const updated = await tx.inventory.update({
          where: { id: row.id },
          data: {
            quantity,
            safetyStock: dto.safetyStock,
            version: { increment: 1 },
          },
          select: {
            sourceId: true,
            variantId: true,
            quantity: true,
            reserved: true,
            safetyStock: true,
            version: true,
            source: { select: { code: true } },
            variant: { select: { sku: true } },
          },
        });
        const delta = quantity - row.quantity;
        if (delta)
          await tx.inventoryMovement.create({
            data: {
              sourceId: dto.sourceId,
              variantId,
              delta,
              quantityAfter: quantity,
              reason:
                dto.reason ??
                (dto.quantity !== undefined
                  ? 'CORRECTION'
                  : delta > 0
                    ? 'RECEIPT'
                    : 'ADJUSTMENT'),
              reference: dto.reference ?? null,
              note: dto.note ?? null,
              actorLabel: actor.label,
            },
          });
        after.add(
          new EntityEvent(
            INVENTORY_EVENTS.ADJUSTED,
            actorOf(actor),
            'inventory',
            row.id,
            {
              sku: updated.variant.sku,
              source: updated.source.code,
              delta,
              quantity,
              safetyStock: updated.safetyStock,
            },
          ),
        );
        after.add(
          new ProjectionEvent<InventoryChangedData>(INVENTORY_EVENTS.CHANGED, {
            variantIds: [variantId],
          }),
        );
        const { source, variant, ...r } = updated;
        return {
          ...r,
          sourceCode: source.code,
          sku: variant.sku,
          salable: salableOf(r),
        };
      },
    });
  }

  async movements(q: ListMovementsQueryDto): Promise<Paginated<MovementDto>> {
    const where: Prisma.InventoryMovementWhereInput = {
      sourceId: q.sourceId,
      variantId: q.variantId,
      ...(q.productId ? { variant: { productId: q.productId } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        include: { variant: { select: { sku: true } } },
        orderBy: { createdAt: q.order },
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return paginated(
      rows.map(({ variant, ...m }) => ({ ...m, sku: variant.sku })),
      total,
      q,
    );
  }
}

async function variantsAt(
  tx: Prisma.TransactionClient,
  sourceIds: string[],
): Promise<string[]> {
  const rows = await tx.inventory.findMany({
    where: { sourceId: { in: sourceIds } },
    select: { variantId: true },
    distinct: ['variantId'],
  });
  return rows.map((r) => r.variantId);
}
