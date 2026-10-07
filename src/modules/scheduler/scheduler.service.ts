import { Injectable, Logger } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  CONTENT_SCHEDULE_EVENTS,
  type ScheduleDueData,
  type ScheduleRequest,
} from '../../common/content/publishing.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type {
  ContentType,
  Prisma,
  ScheduleAction,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ListSchedulesQueryDto, ScheduleDto } from './dto/schedule.dto.js';
import { SCHEDULE_EVENTS } from './scheduler.events.js';

const BATCH = 100;

const SELECT = {
  id: true,
  targetType: true,
  targetId: true,
  action: true,
  runAt: true,
  status: true,
  attempts: true,
  executedAt: true,
  createdById: true,
  createdAt: true,
} as const satisfies Prisma.ScheduleSelect;

/**
 * Publish/unpublish schedules (PLAN.md §9 & §14 Phase 4). Content modules request schedules with
 * `content.schedule-requested`; due rows are claimed with SKIP LOCKED (safe with several workers)
 * and handed back to the owning module as `schedule.due`.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(q: ListSchedulesQueryDto): Promise<Paginated<ScheduleDto>> {
    const where: Prisma.ScheduleWhereInput = {
      status: q.status,
      targetType: q.targetType,
      targetId: q.targetId,
    };
    const [rows, total] = await Promise.all([
      this.prisma.schedule.findMany({
        where,
        select: SELECT,
        orderBy: [{ runAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.schedule.count({ where }),
    ]);
    const labels = await this.labels(rows);
    return paginated(
      rows.map((r) => ({ ...r, targetLabel: labels.get(r.targetId) ?? null })),
      total,
      q,
    );
  }

  /** Human names of schedule targets, one query per content type on the page. */
  private async labels(
    rows: readonly { targetType: ContentType; targetId: string }[],
  ): Promise<Map<string, string>> {
    const ids = (type: ContentType) => [
      ...new Set(
        rows.filter((r) => r.targetType === type).map((r) => r.targetId),
      ),
    ];
    const first = <T extends { title: string | null }>(ts: T[]) =>
      ts.find((x) => x.title)?.title ?? null;
    const tr = {
      select: { title: true },
      orderBy: { localeCode: 'asc' as const },
    };
    const [pages, posts, blocks, banners, sliders, campaigns, promotions] =
      await Promise.all([
        this.prisma.page.findMany({
          where: { id: { in: ids('PAGE') } },
          select: { id: true, translations: tr },
        }),
        this.prisma.post.findMany({
          where: { id: { in: ids('POST') } },
          select: { id: true, translations: tr },
        }),
        this.prisma.block.findMany({
          where: { id: { in: ids('BLOCK') } },
          select: { id: true, identifier: true },
        }),
        this.prisma.banner.findMany({
          where: { id: { in: ids('BANNER') } },
          select: { id: true, name: true },
        }),
        this.prisma.slider.findMany({
          where: { id: { in: ids('SLIDER') } },
          select: { id: true, name: true },
        }),
        this.prisma.campaign.findMany({
          where: { id: { in: ids('CAMPAIGN') } },
          select: { id: true, name: true },
        }),
        this.prisma.promotion.findMany({
          where: { id: { in: ids('PROMOTION') } },
          select: { id: true, name: true },
        }),
      ]);
    const out = new Map<string, string>();
    for (const p of [...pages, ...posts]) {
      const title = first(p.translations);
      if (title) out.set(p.id, title);
    }
    for (const b of blocks) out.set(b.id, b.identifier);
    for (const x of [...banners, ...sliders, ...campaigns, ...promotions])
      out.set(x.id, x.name);
    return out;
  }

  /** Sets (upserts) or cancels the pending schedule of each target/action. Idempotent. */
  async apply(
    requests: readonly ScheduleRequest[],
    actorId: string | null,
  ): Promise<void> {
    if (!requests.length) return;
    await this.bus.write({
      before: new BeforeWriteEvent(
        SCHEDULE_EVENTS.BEFORE_WRITE,
        'apply',
        null,
        SYSTEM_ACTOR,
        requests,
      ),
      work: async (tx, after) => {
        for (const r of requests) {
          if (r.runAt === null) {
            await tx.schedule.updateMany({
              where: {
                targetType: r.targetType,
                targetId: r.targetId,
                action: r.action,
                status: 'PENDING',
              },
              data: { status: 'CANCELLED' },
            });
            continue;
          }
          // One pending row per target/action (uq_schedules_pending_target_action).
          await tx.$executeRaw`
            INSERT INTO schedules (target_type, target_id, action, run_at, created_by_id, updated_at)
            VALUES (${r.targetType}::"ContentType", ${r.targetId}::uuid, ${r.action}::"ScheduleAction",
                    ${new Date(r.runAt)}, ${actorId}::uuid, now())
            ON CONFLICT (target_type, target_id, action) WHERE status = 'PENDING'::"ScheduleStatus"
            DO UPDATE SET run_at = EXCLUDED.run_at, created_by_id = COALESCE(EXCLUDED.created_by_id, schedules.created_by_id), updated_at = now()`;
        }
        after.add(
          new ProjectionEvent(SCHEDULE_EVENTS.CHANGED, {
            requests: [...requests],
          }),
        );
      },
    });
  }

  /** Claims due schedules in batches and emits `schedule.due` for each; returns how many ran. */
  async runDue(now = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.bus.write({
        before: new BeforeWriteEvent(
          SCHEDULE_EVENTS.BEFORE_WRITE,
          'run-due',
          null,
          SYSTEM_ACTOR,
        ),
        work: async (tx, after) => {
          const due = await tx.$queryRaw<
            {
              id: string;
              targetType: ContentType;
              targetId: string;
              action: ScheduleAction;
              runAt: Date;
            }[]
          >`
            SELECT id, target_type AS "targetType", target_id AS "targetId", action, run_at AS "runAt"
              FROM schedules
             WHERE status = 'PENDING'::"ScheduleStatus" AND run_at <= ${now}
             ORDER BY run_at, id
             LIMIT ${BATCH}
               FOR UPDATE SKIP LOCKED`;
          if (!due.length) return 0;
          await tx.schedule.updateMany({
            where: { id: { in: due.map((d) => d.id) } },
            data: {
              status: 'DONE',
              executedAt: now,
              attempts: { increment: 1 },
            },
          });
          for (const d of due)
            after.add(
              new ProjectionEvent<ScheduleDueData>(
                CONTENT_SCHEDULE_EVENTS.DUE,
                {
                  scheduleId: d.id,
                  targetType: d.targetType,
                  targetId: d.targetId,
                  action: d.action,
                  runAt: d.runAt.toISOString(),
                },
              ),
            );
          return due.length;
        },
      });
      total += n;
      if (n < BATCH) break;
    }
    if (total) this.logger.log(`Ran ${total} due schedule(s)`);
    return total;
  }
}
