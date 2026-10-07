import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { isVisible } from '../../common/content/publishing.js';
import { diff } from '../../common/events/audited.event.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type {
  CampaignDto,
  CreateCampaignDto,
  ListMarketingQueryDto,
  UpdateCampaignDto,
} from './dto/marketing.dto.js';
import { CAMPAIGN_EVENTS } from './marketing.events.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  budgetAmount: true,
  budgetCurrencyCode: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { promotions: true } },
} as const satisfies Prisma.CampaignSelect;

type Row = Prisma.CampaignGetPayload<{ select: typeof SELECT }>;

const toDto = (
  { _count, budgetAmount, ...r }: Row,
  now = new Date(),
): CampaignDto => ({
  ...r,
  budgetAmount: budgetAmount?.toString() ?? null,
  promotionCount: _count.promotions,
  visible: isVisible(r, now),
});

/**
 * Campaigns group promotions (and so their coupons) under one schedule: publishing a campaign
 * with `at` starts them all at that time, unpublishing (now or later) ends them.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
  ) {}

  async list(q: ListMarketingQueryDto): Promise<Paginated<CampaignDto>> {
    const where: Prisma.CampaignWhereInput = {
      status: q.status,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { code: { contains: q.search.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        select: SELECT,
        orderBy: [{ createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.campaign.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<CampaignDto> {
    const r = await this.prisma.campaign.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Campaign ${id} not found`);
    return toDto(r);
  }

  async create(dto: CreateCampaignDto, actor: Principal): Promise<CampaignDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CAMPAIGN_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const r = await tx.campaign.create({
          data: {
            code: dto.code,
            name: dto.name,
            description: dto.description ?? null,
            budgetAmount:
              dto.budgetAmount === undefined ? null : BigInt(dto.budgetAmount),
            budgetCurrencyCode:
              dto.budgetAmount === undefined ? null : dto.budgetCurrencyCode,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            CAMPAIGN_EVENTS.CREATED,
            actorOf(actor),
            'campaign',
            r.id,
            {
              code: r.code,
            },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateCampaignDto,
    actor: Principal,
  ): Promise<CampaignDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        CAMPAIGN_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.campaign.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Campaign ${id} not found`);
        const r = await tx.campaign.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            budgetAmount:
              dto.budgetAmount === undefined
                ? undefined
                : dto.budgetAmount === null
                  ? null
                  : BigInt(dto.budgetAmount),
            budgetCurrencyCode: dto.budgetCurrencyCode,
          },
          select: SELECT,
        });
        const changes = diff({ ...toDto(before) }, { ...toDto(r) }, [
          'name',
          'description',
          'budgetAmount',
          'budgetCurrencyCode',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              CAMPAIGN_EVENTS.UPDATED,
              actorOf(actor),
              'campaign',
              id,
              changes,
            ),
          );
        return toDto(r);
      },
    });
  }

  /** Only an empty campaign can be deleted (its promotions would otherwise run unscheduled). */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        CAMPAIGN_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.campaign.findUnique({
          where: { id },
          select: { code: true, _count: { select: { promotions: true } } },
        });
        if (!r) throw new NotFoundException(`Campaign ${id} not found`);
        if (r._count.promotions)
          throw new ConflictException(
            'The campaign still has promotions; archive it (unpublish) or move them first',
          );
        await tx.campaign.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'campaign', id);
        after.add(
          new EntityEvent(
            CAMPAIGN_EVENTS.DELETED,
            actorOf(actor),
            'campaign',
            id,
            {
              code: r.code,
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
  ): Promise<CampaignDto> {
    await this.publisher.change(
      'campaign',
      id,
      CAMPAIGN_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }
}
