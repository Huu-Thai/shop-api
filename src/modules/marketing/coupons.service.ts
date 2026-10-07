import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  actorOf,
  type Principal,
  SYSTEM_ACTOR,
} from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type CouponsGenerateJob, JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { randomCode } from './coupon-codes.js';
import type {
  CouponDto,
  CreateCouponDto,
  GenerateCouponsDto,
  GenerateCouponsResultDto,
  ListCouponsQueryDto,
  UpdateCouponDto,
} from './dto/marketing.dto.js';
import { COUPON_EVENTS } from './marketing.events.js';

const SELECT = {
  id: true,
  promotionId: true,
  code: true,
  usageLimit: true,
  usesPerCustomer: true,
  timesUsed: true,
  expiresAt: true,
  isActive: true,
  batchId: true,
  createdAt: true,
} as const satisfies Prisma.CouponSelect;

const CHUNK = 1000;
const MAX_ROUNDS = 20;

/** Coupons of coupon-only promotions: one by one, or generated in bulk by the `coupons` worker. */
@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    @InjectQueue(QUEUES.COUPONS)
    private readonly queue: Queue<CouponsGenerateJob>,
  ) {}

  async list(
    promotionId: string,
    q: ListCouponsQueryDto,
  ): Promise<Paginated<CouponDto>> {
    const where: Prisma.CouponWhereInput = {
      promotionId,
      batchId: q.batchId,
      ...(q.search
        ? { code: { startsWith: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where,
        select: SELECT,
        orderBy: [{ createdAt: q.order }, { code: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.coupon.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  private async couponPromotion(promotionId: string): Promise<void> {
    const p = await this.prisma.promotion.findUnique({
      where: { id: promotionId },
      select: { requiresCoupon: true },
    });
    if (!p) throw new NotFoundException(`Promotion ${promotionId} not found`);
    if (!p.requiresCoupon)
      throw new BadRequestException(
        'Coupons belong to promotions that require a coupon (set requiresCoupon first)',
      );
  }

  async create(
    promotionId: string,
    dto: CreateCouponDto,
    actor: Principal,
  ): Promise<CouponDto> {
    await this.couponPromotion(promotionId);
    return this.bus.write({
      before: new BeforeWriteEvent(
        COUPON_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { promotionId },
      ),
      work: async (tx, after) => {
        const c = await tx.coupon.create({
          data: {
            promotionId,
            code: dto.code,
            usageLimit: dto.usageLimit ?? null,
            usesPerCustomer: dto.usesPerCustomer ?? null,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            COUPON_EVENTS.CREATED,
            actorOf(actor),
            'coupon',
            c.id,
            {
              promotionId,
              code: c.code,
            },
          ),
        );
        return c;
      },
    });
  }

  /** Queues a batch; the codes appear as the worker creates them (`batchId` lists them). */
  async generate(
    promotionId: string,
    dto: GenerateCouponsDto,
    actor: Principal,
  ): Promise<GenerateCouponsResultDto> {
    await this.couponPromotion(promotionId);
    const prefix = (dto.prefix ?? '').toUpperCase();
    const length = dto.length ?? 10;
    // 31^6 ≈ 8.9e8 combinations at the minimum length, ≫ the 100 000 codes of a batch.
    const batchId = randomUUID();
    await this.bus.write({
      before: new BeforeWriteEvent(
        COUPON_EVENTS.BEFORE_WRITE,
        'generate',
        null,
        actorOf(actor),
        { promotionId, count: dto.count },
      ),
      work: async (_tx, after) => {
        after.add(
          new EntityEvent(
            COUPON_EVENTS.CREATED,
            actorOf(actor),
            'coupon_batch',
            batchId,
            {
              promotionId,
              count: dto.count,
              prefix,
            },
          ),
        );
      },
    });
    await this.queue.add(
      JOBS.COUPONS_GENERATE,
      {
        promotionId,
        batchId,
        count: dto.count,
        prefix,
        length,
        usageLimit: dto.usageLimit ?? 1,
        usesPerCustomer: dto.usesPerCustomer ?? null,
        expiresAt: dto.expiresAt ?? null,
      },
      {
        jobId: `coupons-${batchId}`,
        attempts: 3,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return { batchId, count: dto.count };
  }

  /** Worker side: creates the batch in chunks; a retried job continues where it stopped. */
  async runGeneration(job: CouponsGenerateJob): Promise<number> {
    let created = await this.prisma.coupon.count({
      where: { batchId: job.batchId },
    });
    for (let round = 0; created < job.count; round++) {
      if (round >= MAX_ROUNDS * Math.ceil(job.count / CHUNK))
        throw new Error(
          `Could not generate unique codes for batch ${job.batchId}`,
        );
      const want = Math.min(CHUNK, job.count - created);
      const codes = [
        ...new Set(
          Array.from({ length: want }, () =>
            randomCode(job.prefix, job.length),
          ),
        ),
      ];
      const n = await this.bus.write({
        before: new BeforeWriteEvent(
          COUPON_EVENTS.BEFORE_WRITE,
          'generate-chunk',
          null,
          SYSTEM_ACTOR,
          { promotionId: job.promotionId, batchId: job.batchId },
        ),
        work: async (tx, after) => {
          const { count } = await tx.coupon.createMany({
            data: codes.map((code) => ({
              promotionId: job.promotionId,
              code,
              batchId: job.batchId,
              usageLimit: job.usageLimit,
              usesPerCustomer: job.usesPerCustomer,
              expiresAt: job.expiresAt ? new Date(job.expiresAt) : null,
            })),
            skipDuplicates: true,
          });
          after.add(
            new ProjectionEvent(COUPON_EVENTS.GENERATED, {
              promotionId: job.promotionId,
              batchId: job.batchId,
              created: count,
            }),
          );
          return count;
        },
      });
      created += n;
    }
    this.logger.log(`Coupon batch ${job.batchId}: ${created} codes`);
    return created;
  }

  async update(
    id: string,
    dto: UpdateCouponDto,
    actor: Principal,
  ): Promise<CouponDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        COUPON_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(actor),
        dto,
      ),
      work: async (tx, after) => {
        const before = await tx.coupon.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Coupon ${id} not found`);
        if (
          dto.usageLimit !== undefined &&
          dto.usageLimit !== null &&
          dto.usageLimit < before.timesUsed
        )
          throw new BadRequestException(
            `usageLimit cannot be below the ${before.timesUsed} uses so far`,
          );
        const c = await tx.coupon.update({
          where: { id },
          data: {
            isActive: dto.isActive,
            usageLimit: dto.usageLimit,
            usesPerCustomer: dto.usesPerCustomer,
            expiresAt:
              dto.expiresAt === undefined
                ? undefined
                : dto.expiresAt && new Date(dto.expiresAt),
          },
          select: SELECT,
        });
        const changes = diff(before, c, [
          'isActive',
          'usageLimit',
          'usesPerCustomer',
          'expiresAt',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              COUPON_EVENTS.UPDATED,
              actorOf(actor),
              'coupon',
              id,
              changes,
            ),
          );
        return c;
      },
    });
  }

  /** Only unused coupons can be deleted (deactivate used ones). */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        COUPON_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const c = await tx.coupon.findUnique({
          where: { id },
          select: { code: true, promotionId: true },
        });
        if (!c) throw new NotFoundException(`Coupon ${id} not found`);
        await tx.coupon.delete({ where: { id } });
        after.add(
          new EntityEvent(
            COUPON_EVENTS.DELETED,
            actorOf(actor),
            'coupon',
            id,
            c,
          ),
        );
      },
    });
  }
}
