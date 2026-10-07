import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  actorOf,
  type Principal,
  SYSTEM_ACTOR,
} from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { ReservationStatus } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ProductsQuery } from '../products/products.query.js';
import { allocate, salableOf, type SourceStock } from './allocation.js';
import type { ReservationDto, ReserveDto } from './dto/inventory.dto.js';
import {
  INVENTORY_EVENTS,
  type InventoryChangedData,
} from './inventory.events.js';
import { InventoryQuery } from './inventory.query.js';

export const DEFAULT_RESERVATION_TTL_S = 15 * 60;

/**
 * Reservations (PLAN.md §9): stock is held on checkout start, converted to a sale when paid, or
 * released (cancel, expiry). Reserving locks the variant's stock rows at the website's sources in
 * a fixed order (no deadlocks), allocates by source priority and fails with 409 when short — so
 * concurrent checkouts can never oversell. A CHECK (reserved ≤ quantity) is the last line.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly products: ProductsQuery,
    private readonly inventory: InventoryQuery,
  ) {}

  async reserve(dto: ReserveDto, actor?: Principal): Promise<ReservationDto> {
    const variantId =
      dto.variantId ??
      (dto.sku
        ? (await this.products.variantIdsBySku([dto.sku])).get(dto.sku)
        : undefined);
    if (!variantId)
      throw new BadRequestException(
        dto.sku ? `Unknown SKU ${dto.sku}` : 'variantId or sku is required',
      );
    const managed = await this.inventory.isManaged(variantId);
    if (managed === undefined)
      throw new BadRequestException(`Variant ${variantId} does not exist`);
    const groupId = dto.groupId ?? randomUUID();
    if (!managed)
      return {
        groupId,
        variantId,
        quantity: dto.quantity,
        status: 'ACTIVE',
        expiresAt: null,
        managed: false,
        lines: [],
      };
    const expiresAt = new Date(
      Date.now() + (dto.ttlSeconds ?? DEFAULT_RESERVATION_TTL_S) * 1000,
    );

    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_EVENTS.BEFORE_WRITE,
        'reserve',
        variantId,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        // A caller-chosen group id makes retries safe: the group is only reserved once.
        if (dto.groupId) {
          const existing = await tx.inventoryReservation.findMany({
            where: { groupId },
            orderBy: { sourceId: 'asc' },
          });
          if (existing.length) return toDto(groupId, existing);
        }
        // Lock in id order (stable across websites), allocate in source priority order.
        const locked = await tx.$queryRaw<
          (SourceStock & { priority: number })[]
        >`
          SELECT i.id AS "inventoryId", i.source_id AS "sourceId", i.quantity, i.reserved, i.safety_stock AS "safetyStock", w.priority
            FROM inventories i
            JOIN website_inventory_sources w ON w.source_id = i.source_id AND w.website_id = ${dto.websiteId}::uuid
            JOIN inventory_sources s ON s.id = i.source_id AND s.is_active
           WHERE i.variant_id = ${variantId}::uuid
           ORDER BY i.id
             FOR UPDATE OF i`;
        const ordered = [...locked].sort(
          (a, b) =>
            a.priority - b.priority || a.sourceId.localeCompare(b.sourceId),
        );
        const plan = allocate(ordered, dto.quantity);
        if (!plan) {
          const available = ordered.reduce((n, s) => n + salableOf(s), 0);
          throw new ConflictException(`Only ${available} unit(s) available`);
        }
        for (const { source, quantity } of plan) {
          await tx.inventory.update({
            where: { id: source.inventoryId },
            data: {
              reserved: { increment: quantity },
              version: { increment: 1 },
            },
          });
          await tx.inventoryReservation.create({
            data: {
              variantId,
              sourceId: source.sourceId,
              quantity,
              groupId,
              referenceType: dto.referenceType,
              referenceId: dto.referenceId,
              expiresAt,
            },
          });
        }
        after.add(
          new ProjectionEvent(INVENTORY_EVENTS.RESERVED, {
            groupId,
            variantId,
            quantity: dto.quantity,
            referenceType: dto.referenceType,
            referenceId: dto.referenceId,
          }),
        );
        after.add(
          new ProjectionEvent<InventoryChangedData>(INVENTORY_EVENTS.CHANGED, {
            variantIds: [variantId],
          }),
        );
        return {
          groupId,
          variantId,
          quantity: dto.quantity,
          status: 'ACTIVE' as const,
          expiresAt,
          managed: true,
          lines: plan.map((p) => ({
            sourceId: p.source.sourceId,
            quantity: p.quantity,
          })),
        };
      },
    });
  }

  /** Gives the stock back (cart abandoned, order cancelled). Idempotent. */
  release(groupId: string, actor?: Principal): Promise<ReservationDto> {
    return this.finish(groupId, 'RELEASED', actor);
  }

  /** The reserved units are sold: physical quantity goes down, the ledger records the sale. */
  convert(
    groupId: string,
    reference: string | undefined,
    actor?: Principal,
  ): Promise<ReservationDto> {
    return this.finish(groupId, 'CONVERTED', actor, reference);
  }

  /**
   * Puts sold units back on the shelves they came from (a cancelled or refunded order): physical
   * quantity goes up with RETURN movements. Idempotent per `reference` (e.g. `REFUND:<id>`).
   */
  async returnStock(
    groupId: string,
    quantity: number,
    reference: string,
    actor?: Principal,
  ): Promise<number> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_EVENTS.BEFORE_WRITE,
        'return',
        groupId,
        actorOf(actor),
        { quantity, reference },
      ),
      work: async (tx, after) => {
        const rows = await tx.inventoryReservation.findMany({
          where: { groupId, status: 'CONVERTED' },
          orderBy: { sourceId: 'asc' },
        });
        if (!rows.length) return 0;
        const done = await tx.inventoryMovement.count({
          where: { variantId: rows[0].variantId, reason: 'RETURN', reference },
        });
        if (done) return 0;
        let left = Math.min(
          quantity,
          rows.reduce((n, r) => n + r.quantity, 0),
        );
        let returned = 0;
        for (const r of rows) {
          if (left <= 0) break;
          const q = Math.min(left, r.quantity);
          const [inv] = await tx.$queryRaw<{ quantity: number }[]>`
            UPDATE inventories SET quantity = quantity + ${q}, version = version + 1, updated_at = now()
             WHERE source_id = ${r.sourceId}::uuid AND variant_id = ${r.variantId}::uuid RETURNING quantity`;
          if (!inv) continue;
          await tx.inventoryMovement.create({
            data: {
              sourceId: r.sourceId,
              variantId: r.variantId,
              delta: q,
              quantityAfter: inv.quantity,
              reason: 'RETURN',
              reference,
              actorLabel: actorOf(actor).label,
            },
          });
          left -= q;
          returned += q;
        }
        if (returned)
          after.add(
            new ProjectionEvent<InventoryChangedData>(
              INVENTORY_EVENTS.CHANGED,
              {
                variantIds: [rows[0].variantId],
              },
            ),
          );
        return returned;
      },
    });
  }

  private async finish(
    groupId: string,
    status: Exclude<ReservationStatus, 'ACTIVE'>,
    actor?: Principal,
    reference?: string,
  ): Promise<ReservationDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        INVENTORY_EVENTS.BEFORE_WRITE,
        status.toLowerCase(),
        groupId,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const all = await tx.inventoryReservation.findMany({
          where: { groupId },
          orderBy: { sourceId: 'asc' },
        });
        if (!all.length)
          throw new NotFoundException(`Reservation ${groupId} not found`);
        const active = await tx.$queryRaw<
          {
            id: string;
            source_id: string;
            variant_id: string;
            quantity: number;
          }[]
        >`
          SELECT id, source_id, variant_id, quantity FROM inventory_reservations
           WHERE group_id = ${groupId}::uuid AND status = 'ACTIVE' ORDER BY source_id FOR UPDATE`;
        if (!active.length) {
          const current = all[0].status;
          if (
            current !== status &&
            !(status === 'RELEASED' && current === 'EXPIRED')
          )
            throw new ConflictException(
              `Reservation is already ${current.toLowerCase()}`,
            );
          return toDto(groupId, all);
        }
        for (const r of active) {
          if (status === 'CONVERTED') {
            const [inv] = await tx.$queryRaw<{ quantity: number }[]>`
              UPDATE inventories SET quantity = quantity - ${r.quantity}, reserved = reserved - ${r.quantity}, version = version + 1, updated_at = now()
               WHERE source_id = ${r.source_id}::uuid AND variant_id = ${r.variant_id}::uuid RETURNING quantity`;
            await tx.inventoryMovement.create({
              data: {
                sourceId: r.source_id,
                variantId: r.variant_id,
                delta: -r.quantity,
                quantityAfter: inv.quantity,
                reason: 'SALE',
                reference:
                  reference ?? `${all[0].referenceType}:${all[0].referenceId}`,
                actorLabel: actorOf(actor).label,
              },
            });
          } else
            await tx.$executeRaw`
              UPDATE inventories SET reserved = reserved - ${r.quantity}, version = version + 1, updated_at = now()
               WHERE source_id = ${r.source_id}::uuid AND variant_id = ${r.variant_id}::uuid`;
        }
        await tx.inventoryReservation.updateMany({
          where: { id: { in: active.map((r) => r.id) } },
          data: { status },
        });
        after.add(
          new ProjectionEvent(
            status === 'CONVERTED'
              ? INVENTORY_EVENTS.CONVERTED
              : INVENTORY_EVENTS.RELEASED,
            { groupId, status },
          ),
        );
        after.add(
          new ProjectionEvent<InventoryChangedData>(INVENTORY_EVENTS.CHANGED, {
            variantIds: [...new Set(active.map((r) => r.variant_id))],
          }),
        );
        return toDto(
          groupId,
          all.map((r) => ({ ...r, status })),
        );
      },
    });
  }

  async get(groupId: string): Promise<ReservationDto> {
    const rows = await this.prisma.inventoryReservation.findMany({
      where: { groupId },
      orderBy: { sourceId: 'asc' },
    });
    if (!rows.length)
      throw new NotFoundException(`Reservation ${groupId} not found`);
    return toDto(groupId, rows);
  }

  /** Releases expired reservations (each group in its own transaction; safe to run concurrently). */
  async expire(now = new Date(), limit = 500): Promise<number> {
    const groups = await this.prisma.inventoryReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      distinct: ['groupId'],
      select: { groupId: true },
      take: limit,
    });
    let expired = 0;
    for (const { groupId } of groups) {
      try {
        await this.finish(groupId, 'EXPIRED', undefined);
        expired++;
      } catch (e) {
        // Converted or released concurrently: nothing to do.
        if (!(e instanceof ConflictException)) throw e;
      }
    }
    if (expired) this.logger.log(`Expired ${expired} reservation(s)`);
    return expired;
  }

  /**
   * Repairs `inventories.reserved` drift against the active reservations. Each row is fixed under
   * its row lock (the same lock reservations take), so concurrent checkouts can't race the fix.
   */
  async reconcile(): Promise<{ checked: number; fixed: number }> {
    const drift = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM inventories i
        LEFT JOIN inventory_reservations r ON r.source_id = i.source_id AND r.variant_id = i.variant_id AND r.status = 'ACTIVE'
       GROUP BY i.id, i.reserved
      HAVING i.reserved <> COALESCE(SUM(r.quantity), 0)`;
    let fixed = 0;
    for (const { id } of drift)
      await this.bus.write({
        before: new BeforeWriteEvent(
          INVENTORY_EVENTS.BEFORE_WRITE,
          'reconcile',
          id,
          SYSTEM_ACTOR,
        ),
        work: async (tx, after) => {
          const [row] = await tx.$queryRaw<
            { variant_id: string; source_id: string; reserved: number }[]
          >`
            SELECT variant_id, source_id, reserved FROM inventories WHERE id = ${id}::uuid FOR UPDATE`;
          const [{ active }] = await tx.$queryRaw<{ active: number }[]>`
            SELECT COALESCE(SUM(quantity), 0)::int AS active FROM inventory_reservations
             WHERE source_id = ${row.source_id}::uuid AND variant_id = ${row.variant_id}::uuid AND status = 'ACTIVE'`;
          if (active === row.reserved) return;
          await tx.inventory.update({
            where: { id },
            data: { reserved: active, version: { increment: 1 } },
          });
          this.logger.warn(
            `Reserved drift fixed on inventory ${id}: ${row.reserved} → ${active}`,
          );
          fixed++;
          after.add(
            new ProjectionEvent(INVENTORY_EVENTS.RECONCILED, {
              inventoryId: id,
              from: row.reserved,
              to: active,
            }),
          );
          after.add(
            new ProjectionEvent<InventoryChangedData>(
              INVENTORY_EVENTS.CHANGED,
              { variantIds: [row.variant_id] },
            ),
          );
        },
      });
    return { checked: drift.length, fixed };
  }
}

function toDto(
  groupId: string,
  rows: {
    variantId: string;
    sourceId: string;
    quantity: number;
    status: ReservationStatus;
    expiresAt: Date;
  }[],
): ReservationDto {
  return {
    groupId,
    variantId: rows[0].variantId,
    quantity: rows.reduce((n, r) => n + r.quantity, 0),
    status: rows[0].status,
    expiresAt: rows[0].expiresAt,
    managed: true,
    lines: rows.map((r) => ({ sourceId: r.sourceId, quantity: r.quantity })),
  };
}
