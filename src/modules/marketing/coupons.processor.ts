import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { type CouponsGenerateJob, JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { CouponsService } from './coupons.service.js';

@Processor(QUEUES.COUPONS, { concurrency: 2 })
export class CouponsProcessor extends WorkerHost {
  constructor(private readonly coupons: CouponsService) {
    super();
  }

  process(job: Job<CouponsGenerateJob>) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.COUPONS_GENERATE)
        return { created: await this.coupons.runGeneration(job.data) };
      return { skipped: `unknown job ${job.name}` };
    });
  }
}
