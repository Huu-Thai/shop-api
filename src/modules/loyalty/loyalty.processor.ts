import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { LoyaltyService } from './loyalty.service.js';

@Processor(QUEUES.LOYALTY, { concurrency: 1 })
export class LoyaltyProcessor extends WorkerHost {
  constructor(private readonly loyalty: LoyaltyService) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.LOYALTY_EXPIRE_POINTS)
        return { expired: await this.loyalty.expireDue() };
      if (job.name === JOBS.LOYALTY_EVALUATE_TIERS)
        return { changed: await this.loyalty.evaluateTiers() };
      return { skipped: `unknown job ${job.name}` };
    });
  }
}

/** Daily: expire points (02:30 UTC), then re-evaluate tiers on the rolling window (03:30 UTC). */
@Injectable()
export class LoyaltyScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.LOYALTY) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expire-points',
      { pattern: '30 2 * * *', tz: 'UTC' },
      {
        name: JOBS.LOYALTY_EXPIRE_POINTS,
        data: {},
        opts: { removeOnComplete: 30 },
      },
    );
    await this.queue.upsertJobScheduler(
      'evaluate-tiers',
      { pattern: '30 3 * * *', tz: 'UTC' },
      {
        name: JOBS.LOYALTY_EVALUATE_TIERS,
        data: {},
        opts: { removeOnComplete: 30 },
      },
    );
  }
}
