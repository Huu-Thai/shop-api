import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { withJobContext } from '../../common/utils/job-context.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  JOBS,
  type JobExecuteJob,
  type JobRunScheduledJob,
} from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { JobExecutor } from './job-executor.js';
import { JobSchedules } from './job-schedules.js';
import { JobsHousekeeping } from './jobs-housekeeping.js';
import { JobsService } from './jobs.service.js';

/** Runs job executions (manual, scheduled, one-off imports/exports) and the jobs housekeeping. */
@Processor(QUEUES.JOBS, {
  concurrency: Math.max(1, Number(process.env.JOBS_CONCURRENCY) || 2),
  // Long imports keep their lock renewed; a worker that dies lets another take the message.
  lockDuration: 60_000,
})
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly executor: JobExecutor,
    private readonly schedules: JobSchedules,
    private readonly housekeeping: JobsHousekeeping,
  ) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      switch (job.name) {
        case JOBS.JOB_EXECUTE:
          return {
            outcome: await this.executor.execute(
              (job.data as JobExecuteJob).executionId,
            ),
          };
        case JOBS.JOB_RUN_SCHEDULED:
          return this.runScheduled((job.data as JobRunScheduledJob).jobId);
        case JOBS.JOBS_REQUEUE:
          return this.housekeeping.requeue();
        case JOBS.JOBS_CLEANUP:
          return this.housekeeping.cleanup();
        default:
          // Messages of the checkout jobs that used to share this queue end here once.
          return { skipped: `unknown job ${job.name}` };
      }
    });
  }

  /** A cron tick: one execution, unless the job is off or its previous run is still open. */
  async runScheduled(jobId: string) {
    const j = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!j?.isActive || !j.cron) {
      await this.schedules.sync(jobId);
      return { skipped: 'job removed or inactive' };
    }
    let executionId: string;
    try {
      executionId = (
        await this.jobs.createExecution({
          jobId: j.id,
          type: j.type,
          params: j.params as Record<string, unknown>,
          trigger: 'SCHEDULE',
          actor: { ...SYSTEM_ACTOR, label: 'scheduler' },
        })
      ).id;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `Job ${j.code}: skipped a scheduled run, the previous one is still queued or running`,
        );
        return { skipped: 'previous run still open' };
      }
      throw e;
    }
    // Run through the same message as any execution, so a worker crash is detected the same way.
    await this.jobs.enqueue(executionId);
    return { executionId };
  }
}

/** Worker start: defined jobs scheduled, lost messages re-queued every 2 minutes, daily cleanup. */
@Injectable()
export class JobsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUES.JOBS) private readonly queue: Queue,
    private readonly schedules: JobSchedules,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.schedules.reconcile();
    await this.queue.upsertJobScheduler(
      'jobs-requeue',
      { every: 2 * 60_000 },
      {
        name: JOBS.JOBS_REQUEUE,
        data: {},
        opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
      },
    );
    await this.queue.upsertJobScheduler(
      'jobs-cleanup',
      { pattern: '30 4 * * *', tz: 'UTC' },
      {
        name: JOBS.JOBS_CLEANUP,
        data: {},
        opts: { removeOnComplete: 30, removeOnFail: 30 },
      },
    );
  }
}
