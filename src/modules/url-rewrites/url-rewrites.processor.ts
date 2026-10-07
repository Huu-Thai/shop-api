import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { isSuperseded } from '../../queue/coalesce.js';
import { JOBS, type UrlRewritesRebuildStoreJob } from '../../queue/jobs.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import { QUEUES } from '../../queue/queue.constants.js';
import {
  storeGenerationKey,
  UrlRewritesService,
} from './url-rewrites.service.js';

/** Catalog projections that are too big to rebuild inline (whole stores). */
@Processor(QUEUES.CATALOG, { concurrency: 1 })
export class CatalogProcessor extends WorkerHost {
  constructor(
    private readonly rewrites: UrlRewritesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  process(job: Job<UrlRewritesRebuildStoreJob>) {
    return withJobContext(job, async () => {
      if (job.name !== JOBS.URL_REWRITES_REBUILD_STORE)
        return { skipped: `unknown job ${job.name}` };
      if (
        await isSuperseded(
          this.redis,
          storeGenerationKey(job.data.storeId),
          job.data.generation,
        )
      )
        return { skipped: 'superseded by a newer rebuild' };
      return this.rewrites.rebuildStore(job.data.storeId);
    });
  }
}
