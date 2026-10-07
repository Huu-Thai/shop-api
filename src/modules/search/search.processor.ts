import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { withJobContext } from '../../common/utils/job-context.js';
import { isSuperseded } from '../../queue/coalesce.js';
import {
  JOBS,
  type SearchIndexProductsJob,
  type SearchWebsiteJob,
} from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import {
  type DropIndexesJob,
  SearchEngines,
} from './search-engines.service.js';
import { SearchIndexer } from './search-indexer.js';
import { websiteGenerationKey } from './search.listener.js';

@Processor(QUEUES.SEARCH_INDEX, { concurrency: 2 })
export class SearchProcessor extends WorkerHost {
  constructor(
    private readonly indexer: SearchIndexer,
    private readonly engines: SearchEngines,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  process(
    job: Job<SearchIndexProductsJob & SearchWebsiteJob & DropIndexesJob>,
  ) {
    return withJobContext(job, async () => {
      switch (job.name) {
        case JOBS.SEARCH_INDEX_PRODUCTS:
          return this.indexer.indexProducts(job.data.productIds);
        case JOBS.SEARCH_REINDEX_WEBSITE:
          if (
            await isSuperseded(
              this.redis,
              websiteGenerationKey(job.data.websiteId),
              job.data.generation,
            )
          )
            return { skipped: 'superseded by a newer reindex' };
          return this.indexer.reindexWebsite(job.data.websiteId);
        case JOBS.SEARCH_SWITCH:
          return this.engines.switch(job.data.websiteId, job.data.generation!);
        case JOBS.SEARCH_DROP_INDEXES:
          return { dropped: await this.engines.drop(job.data) };
        default:
          return { skipped: `unknown job ${job.name}` };
      }
    });
  }
}
