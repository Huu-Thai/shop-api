import { Injectable, NotFoundException } from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  CreateTierDto,
  ProgramDto,
  TierDto,
  UpdateTierDto,
  UpsertProgramDto,
} from './dto/loyalty.dto.js';
import {
  LOYALTY_PROGRAM_EVENTS,
  LOYALTY_TIER_EVENTS,
} from './loyalty.events.js';

const TIER_SELECT = {
  id: true,
  code: true,
  name: true,
  thresholdPoints: true,
  multiplierBp: true,
} as const;

const SELECT = {
  id: true,
  websiteId: true,
  name: true,
  currencyCode: true,
  spendPerPoint: true,
  pointValue: true,
  minRedeemPoints: true,
  maxRedeemPercent: true,
  expiryDays: true,
  tierWindowDays: true,
  isActive: true,
  tiers: { select: TIER_SELECT, orderBy: { thresholdPoints: 'asc' } },
} as const satisfies Prisma.LoyaltyProgramSelect;

type Row = Prisma.LoyaltyProgramGetPayload<{ select: typeof SELECT }>;

const toDto = (r: Row): ProgramDto => ({
  ...r,
  spendPerPoint: r.spendPerPoint.toString(),
  pointValue: r.pointValue.toString(),
});

const FIELDS = [
  'name',
  'currencyCode',
  'spendPerPoint',
  'pointValue',
  'minRedeemPoints',
  'maxRedeemPercent',
  'expiryDays',
  'tierWindowDays',
  'isActive',
];

/** Loyalty programs (one per website) and their tiers. */
@Injectable()
export class LoyaltyProgramsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(): Promise<ProgramDto[]> {
    const rows = await this.prisma.loyaltyProgram.findMany({
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDto);
  }

  async get(websiteId: string): Promise<ProgramDto> {
    const r = await this.prisma.loyaltyProgram.findUnique({
      where: { websiteId },
      select: SELECT,
    });
    if (!r)
      throw new NotFoundException(
        `Website ${websiteId} has no loyalty program`,
      );
    return toDto(r);
  }

  /** Creates or replaces the program of a website (existing points keep their expiry dates). */
  async upsert(
    websiteId: string,
    dto: UpsertProgramDto,
    actor: Principal,
  ): Promise<ProgramDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        LOYALTY_PROGRAM_EVENTS.BEFORE_WRITE,
        'upsert',
        websiteId,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.loyaltyProgram.findUnique({
          where: { websiteId },
          select: SELECT,
        });
        const data = {
          name: dto.name,
          currencyCode: dto.currencyCode,
          spendPerPoint: BigInt(dto.spendPerPoint),
          pointValue: BigInt(dto.pointValue),
          minRedeemPoints: dto.minRedeemPoints ?? 0,
          maxRedeemPercent: dto.maxRedeemPercent ?? 100,
          expiryDays: dto.expiryDays ?? null,
          tierWindowDays: dto.tierWindowDays ?? 365,
          isActive: dto.isActive ?? true,
        };
        const r = await tx.loyaltyProgram.upsert({
          where: { websiteId },
          create: { websiteId, ...data },
          update: data,
          select: SELECT,
        });
        const changes = before
          ? diff({ ...toDto(before) }, { ...toDto(r) }, FIELDS)
          : { websiteId };
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              before
                ? LOYALTY_PROGRAM_EVENTS.UPDATED
                : LOYALTY_PROGRAM_EVENTS.CREATED,
              actorOf(actor),
              'loyalty_program',
              r.id,
              changes,
            ),
          );
        return toDto(r);
      },
    });
  }

  async addTier(
    websiteId: string,
    dto: CreateTierDto,
    actor: Principal,
  ): Promise<TierDto> {
    const program = await this.get(websiteId);
    return this.bus.write({
      before: new BeforeWriteEvent(
        LOYALTY_TIER_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const t = await tx.loyaltyTier.create({
          data: {
            programId: program.id,
            code: dto.code,
            name: dto.name,
            thresholdPoints: dto.thresholdPoints,
            multiplierBp: dto.multiplierBp ?? 10_000,
          },
          select: TIER_SELECT,
        });
        after.add(
          new EntityEvent(
            LOYALTY_TIER_EVENTS.CREATED,
            actorOf(actor),
            'loyalty_tier',
            t.id,
            { ...t },
          ),
        );
        return t;
      },
    });
  }

  async updateTier(
    id: string,
    dto: UpdateTierDto,
    actor: Principal,
  ): Promise<TierDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        LOYALTY_TIER_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.loyaltyTier.findUnique({
          where: { id },
          select: TIER_SELECT,
        });
        if (!before) throw new NotFoundException(`Tier ${id} not found`);
        const t = await tx.loyaltyTier.update({
          where: { id },
          data: dto,
          select: TIER_SELECT,
        });
        const changes = diff(before, t, [
          'name',
          'thresholdPoints',
          'multiplierBp',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              LOYALTY_TIER_EVENTS.UPDATED,
              actorOf(actor),
              'loyalty_tier',
              id,
              changes,
            ),
          );
        return t;
      },
    });
  }

  /** Accounts in the tier drop to none until the nightly evaluation places them again. */
  async removeTier(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        LOYALTY_TIER_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const t = await tx.loyaltyTier.findUnique({
          where: { id },
          select: { code: true },
        });
        if (!t) throw new NotFoundException(`Tier ${id} not found`);
        await tx.loyaltyTier.delete({ where: { id } });
        after.add(
          new EntityEvent(
            LOYALTY_TIER_EVENTS.DELETED,
            actorOf(actor),
            'loyalty_tier',
            id,
            t,
          ),
        );
      },
    });
  }
}
