import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import type { EntityEvent } from '../../common/events/entity.events.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS, type JobRunScheduledJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { JOB_EVENTS } from './jobs.events.js';
import { schedulerId } from './jobs.service.js';

const AFTER = { async: true, promisify: true } as const;

/** Checkout housekeeping used to share this queue (Phase 6); its schedulers moved to `checkout`. */
const LEGACY_SCHEDULERS = [
  'expire-unpaid-orders',
  'reconcile-payments',
  'purge-carts',
];

/**
 * Keeps BullMQ job schedulers in step with defined jobs: one scheduler (`job:<id>`) per active job
 * with a cron expression. Synced after every job change and reconciled when a worker starts.
 */
@Injectable()
export class JobSchedules {
  private readonly logger = new Logger(JobSchedules.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.JOBS) private readonly queue: Queue,
  ) {}

  @OnEvent(JOB_EVENTS.CREATED, AFTER)
  @OnEvent(JOB_EVENTS.UPDATED, AFTER)
  @OnEvent(JOB_EVENTS.DELETED, AFTER)
  async onJobChanged(e: EntityEvent<{ jobId: string }>): Promise<void> {
    await this.sync(e.data.jobId);
  }

  async sync(jobId: string): Promise<'scheduled' | 'unscheduled'> {
    const j = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { cron: true, timezone: true, isActive: true },
    });
    if (j?.isActive && j.cron) {
      await this.queue.upsertJobScheduler(
        schedulerId(jobId),
        { pattern: j.cron, tz: j.timezone },
        {
          name: JOBS.JOB_RUN_SCHEDULED,
          data: { jobId } satisfies JobRunScheduledJob,
          opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        },
      );
      return 'scheduled';
    }
    await this.queue.removeJobScheduler(schedulerId(jobId));
    return 'unscheduled';
  }

  /** Worker start: every defined job scheduled as configured, nothing else left behind. */
  async reconcile(): Promise<{ scheduled: number; removed: number }> {
    const jobs = await this.prisma.job.findMany({ select: { id: true } });
    let scheduled = 0;
    for (const j of jobs)
      if ((await this.sync(j.id)) === 'scheduled') scheduled++;
    const known = new Set(jobs.map((j) => schedulerId(j.id)));
    let removed = 0;
    for (const s of await this.queue.getJobSchedulers(0, -1)) {
      const id = s.key;
      if (
        (id.startsWith('job:') && !known.has(id)) ||
        LEGACY_SCHEDULERS.includes(id)
      ) {
        await this.queue.removeJobScheduler(id);
        removed++;
      }
    }
    if (removed) this.logger.log(`Removed ${removed} stale job scheduler(s)`);
    return { scheduled, removed };
  }
}
