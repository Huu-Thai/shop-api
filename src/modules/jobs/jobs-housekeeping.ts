import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../database/prisma.service.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StorageService } from '../../storage/storage.service.js';
import { JobExecutor } from './job-executor.js';
import { EXECUTION_EVENTS } from './jobs.events.js';
import { JobsService } from './jobs.service.js';

const DAY = 86_400_000;
/** A queued execution whose message is older than this is queued again. */
const REQUEUE_AFTER_MS = 2 * 60_000;
const BATCH = 500;

/** Lost queue messages, expired files (exports hold personal data) and old history. */
@Injectable()
export class JobsHousekeeping {
  private readonly logger = new Logger(JobsHousekeeping.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly executor: JobExecutor,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUES.JOBS) private readonly queue: Queue,
  ) {}

  private before(action: string) {
    return new BeforeWriteEvent(
      EXECUTION_EVENTS.BEFORE_WRITE,
      action,
      null,
      SYSTEM_ACTOR,
    );
  }

  /**
   * Executions still queued after a while (the queue message was lost) are queued again; running
   * ones whose message is gone (their worker died and the queue gave up) are marked failed.
   */
  async requeue(
    now = new Date(),
  ): Promise<{ requeued: number; abandoned: number }> {
    const cutoff = new Date(now.getTime() - REQUEUE_AFTER_MS);
    const queued = await this.prisma.jobExecution.findMany({
      where: { status: 'QUEUED', createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    for (const e of queued) await this.jobs.enqueue(e.id);
    const running = await this.prisma.jobExecution.findMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    let abandoned = 0;
    for (const e of running) {
      const state = await this.queue.getJobState(e.id);
      if (state === 'active' || state === 'waiting' || state === 'delayed')
        continue;
      await this.executor.abandon(e.id);
      abandoned++;
    }
    return { requeued: queued.length, abandoned };
  }

  async cleanup(
    now = new Date(),
  ): Promise<{ files: number; executions: number }> {
    const { fileRetentionDays, historyDays } = this.config.get('jobs', {
      infer: true,
    });
    let files = 0;
    for (;;) {
      const expired = await this.prisma.jobExecution.findMany({
        where: {
          finishedAt: { lt: new Date(now.getTime() - fileRetentionDays * DAY) },
          OR: [{ outputKey: { not: null } }, { inputKey: { not: null } }],
        },
        select: { id: true, outputKey: true, inputKey: true },
        take: BATCH,
      });
      if (!expired.length) break;
      const keys = expired.flatMap((e) =>
        [e.outputKey, e.inputKey].filter((k): k is string => !!k),
      );
      const { failed } = await this.storage.deleteObjects(keys);
      if (failed.length)
        this.logger.warn(`Could not delete ${failed.length} job file(s)`);
      await this.bus.write({
        before: this.before('expire-files'),
        work: (tx) =>
          tx.jobExecution.updateMany({
            where: { id: { in: expired.map((e) => e.id) } },
            data: { outputKey: null, inputKey: null },
          }),
      });
      files += keys.length;
      if (expired.length < BATCH) break;
    }
    const { count } = await this.bus.write({
      before: this.before('purge'),
      work: (tx) =>
        tx.jobExecution.deleteMany({
          where: {
            finishedAt: { lt: new Date(now.getTime() - historyDays * DAY) },
            outputKey: null,
            inputKey: null,
          },
        }),
    });
    return { files, executions: count };
  }
}
