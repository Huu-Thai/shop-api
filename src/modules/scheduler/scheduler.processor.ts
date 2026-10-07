import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { SchedulerService } from './scheduler.service.js';

@Processor(QUEUES.SCHEDULER, { concurrency: 1 })
export class SchedulerProcessor extends WorkerHost {
  constructor(private readonly scheduler: SchedulerService) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.SCHEDULER_RUN_DUE)
        return { ran: await this.scheduler.runDue() };
      return { skipped: `unknown job ${job.name}` };
    });
  }
}

/** Checks for due schedules every minute (content visibility itself is time-based). */
@Injectable()
export class SchedulerBootstrap implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.SCHEDULER) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'run-due-schedules',
      { every: 60_000 },
      {
        name: JOBS.SCHEDULER_RUN_DUE,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 100 },
      },
    );
  }
}
