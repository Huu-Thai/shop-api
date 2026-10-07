import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { CustomersQuery } from '../customers/customers.query.js';
import type {
  CreatePromotionDto,
  ListPromotionsQueryDto,
  PromotionDto,
  UpdatePromotionDto,
} from './dto/marketing.dto.js';
import { PROMOTION_EVENTS } from './marketing.events.js';
import { type Condition, parseRules } from './promotion-rules.js';

const SELECT = {
  id: true,
  name: true,
  description: true,
  campaignId: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  priority: true,
  stopFurther: true,
  requiresCoupon: true,
  conditions: true,
  actions: true,
  usageLimit: true,
  usesPerCustomer: true,
  timesUsed: true,
  createdAt: true,
  updatedAt: true,
  campaign: {
    select: { status: true, publishedAt: true, unpublishedAt: true },
  },
  websites: { select: { websiteId: true } },
  translations: {
    select: { localeCode: true, label: true },
    orderBy: { localeCode: 'asc' },
  },
} as const satisfies Prisma.PromotionSelect;

type Row = Prisma.PromotionGetPayload<{ select: typeof SELECT }>;

const toDto = (
  { campaign, websites, translations, conditions, actions, ...r }: Row,
  now = new Date(),
): PromotionDto => ({
  ...r,
  // Stored rules were normalized by `parseRules`, so they match the documented shapes.
  conditions: conditions as unknown as PromotionDto['conditions'],
  actions: actions as unknown as PromotionDto['actions'],
  websiteIds: websites.map((w) => w.websiteId).sort(),
  labels: translations,
  visible: isVisible(r, now),
  active: isVisible(r, now) && (!campaign || isVisible(campaign, now)),
});

const FIELDS = [
  'name',
  'description',
  'campaignId',
  'priority',
  'stopFurther',
  'requiresCoupon',
  'conditions',
  'actions',
  'usageLimit',
  'usesPerCustomer',
  'websiteIds',
  'labels',
];

/** Cart promotions (Magento cart price rules): typed rules, websites, labels, publishing. */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly publisher: ContentPublisher,
    private readonly customers: CustomersQuery,
  ) {}

  async list(q: ListPromotionsQueryDto): Promise<Paginated<PromotionDto>> {
    const where: Prisma.PromotionWhereInput = {
      status: q.status,
      campaignId: q.campaignId,
      ...(q.websiteId
        ? { websites: { some: { websiteId: q.websiteId } } }
        : {}),
      ...(q.search
        ? { name: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        select: SELECT,
        orderBy: [{ priority: 'asc' }, { createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.promotion.count({ where }),
    ]);
    const now = new Date();
    return paginated(
      rows.map((r) => toDto(r, now)),
      total,
      q,
    );
  }

  async get(id: string): Promise<PromotionDto> {
    const r = await this.prisma.promotion.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!r) throw new NotFoundException(`Promotion ${id} not found`);
    return toDto(r);
  }

  async create(
    dto: CreatePromotionDto,
    actor: Principal,
  ): Promise<PromotionDto> {
    const rules = parseRules(dto.conditions, dto.actions);
    await this.assertGroups(rules.conditions);
    if (dto.labels) assertUniqueLocales(dto.labels, 'labels');
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROMOTION_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { campaignId: dto.campaignId ?? null, websiteIds: dto.websiteIds },
      ),
      work: async (tx, after) => {
        const r = await tx.promotion.create({
          data: {
            name: dto.name,
            description: dto.description ?? null,
            campaignId: dto.campaignId ?? null,
            priority: dto.priority ?? 0,
            stopFurther: dto.stopFurther ?? false,
            requiresCoupon: dto.requiresCoupon ?? false,
            conditions: rules.conditions as unknown as Prisma.InputJsonValue,
            actions: rules.actions as unknown as Prisma.InputJsonValue,
            usageLimit: dto.usageLimit ?? null,
            usesPerCustomer: dto.usesPerCustomer ?? null,
            websites: {
              create: [...new Set(dto.websiteIds)].map((websiteId) => ({
                websiteId,
              })),
            },
            translations: { create: dto.labels ?? [] },
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            PROMOTION_EVENTS.CREATED,
            actorOf(actor),
            'promotion',
            r.id,
            {
              name: r.name,
              campaignId: r.campaignId,
              requiresCoupon: r.requiresCoupon,
            },
          ),
        );
        return toDto(r);
      },
    });
  }

  async update(
    id: string,
    dto: UpdatePromotionDto,
    actor: Principal,
  ): Promise<PromotionDto> {
    if (dto.labels) assertUniqueLocales(dto.labels, 'labels');
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROMOTION_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        { campaignId: dto.campaignId, websiteIds: dto.websiteIds },
      ),
      work: async (tx, after) => {
        const before = await tx.promotion.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Promotion ${id} not found`);
        let rules: ReturnType<typeof parseRules> | undefined;
        if (dto.conditions !== undefined || dto.actions !== undefined) {
          rules = parseRules(
            dto.conditions ?? before.conditions,
            dto.actions ?? before.actions,
          );
          await this.assertGroups(rules.conditions);
        }
        if (dto.requiresCoupon === false && before.requiresCoupon) {
          const coupons = await tx.coupon.count({ where: { promotionId: id } });
          if (coupons)
            throw new BadRequestException(
              'The promotion has coupons; delete or keep them before dropping the coupon requirement',
            );
        }
        if (dto.websiteIds) {
          const ids = [...new Set(dto.websiteIds)];
          await tx.promotionWebsite.deleteMany({
            where: { promotionId: id, websiteId: { notIn: ids } },
          });
          await tx.promotionWebsite.createMany({
            data: ids.map((websiteId) => ({ promotionId: id, websiteId })),
            skipDuplicates: true,
          });
        }
        if (dto.labels) {
          await tx.promotionTranslation.deleteMany({
            where: { promotionId: id },
          });
          await tx.promotionTranslation.createMany({
            data: dto.labels.map((l) => ({ promotionId: id, ...l })),
          });
        }
        const r = await tx.promotion.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            campaignId: dto.campaignId,
            priority: dto.priority,
            stopFurther: dto.stopFurther,
            requiresCoupon: dto.requiresCoupon,
            ...(rules
              ? {
                  conditions:
                    rules.conditions as unknown as Prisma.InputJsonValue,
                  actions: rules.actions as unknown as Prisma.InputJsonValue,
                }
              : {}),
            usageLimit: dto.usageLimit,
            usesPerCustomer: dto.usesPerCustomer,
            updatedAt: new Date(),
          },
          select: SELECT,
        });
        const changes = diff({ ...toDto(before) }, { ...toDto(r) }, FIELDS);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              PROMOTION_EVENTS.UPDATED,
              actorOf(actor),
              'promotion',
              id,
              changes,
            ),
          );
        return toDto(r);
      },
    });
  }

  /** Coupons go with it; a promotion already used by orders can only be archived. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        PROMOTION_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.promotion.findUnique({
          where: { id },
          select: { name: true },
        });
        if (!r) throw new NotFoundException(`Promotion ${id} not found`);
        await tx.promotion.delete({ where: { id } });
        this.publisher.cancelSchedules(after, 'promotion', id);
        after.add(
          new EntityEvent(
            PROMOTION_EVENTS.DELETED,
            actorOf(actor),
            'promotion',
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
  ): Promise<PromotionDto> {
    await this.publisher.change(
      'promotion',
      id,
      PROMOTION_EVENTS,
      action,
      at ? new Date(at) : undefined,
      actor,
    );
    return this.get(id);
  }

  private async assertGroups(conditions: readonly Condition[]): Promise<void> {
    const wanted = conditions.flatMap((c) =>
      c.type === 'customer_group' ? c.groups : [],
    );
    if (!wanted.length) return;
    const known = new Set((await this.customers.groups()).map((g) => g.code));
    const unknown = wanted.filter((g) => !known.has(g));
    if (unknown.length)
      throw new BadRequestException(
        `Unknown customer groups: ${unknown.join(', ')}`,
      );
  }
}
