import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { withJobContext } from '../../common/utils/job-context.js';
import { isSuperseded } from '../../queue/coalesce.js';
import { JOBS, type PriceIndexRebuildJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import { FULL_REBUILD_GENERATION_KEY } from './price-index.listener.js';
import { PriceIndexer } from './price-indexer.js';

export const REFRESH_CURSOR_KEY = 'price-index:refresh-cursor';

@Processor(QUEUES.PRICE_INDEX, { concurrency: 1 })
export class PriceIndexProcessor extends WorkerHost {
  constructor(
    private readonly indexer: PriceIndexer,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  process(job: Job<PriceIndexRebuildJob>) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.PRICE_INDEX_REBUILD) {
        if (
          await isSuperseded(
            this.redis,
            FULL_REBUILD_GENERATION_KEY,
            job.data.generation,
          )
        )
          return { skipped: 'superseded by a newer full rebuild' };
        return this.indexer.rebuild(job.data.variantIds);
      }
      if (job.name === JOBS.PRICE_INDEX_REFRESH) return this.refresh();
      return { skipped: `unknown job ${job.name}` };
    });
  }

  /**
   * Scheduled prices: books whose validity window opened or closed since the last run get their
   * variants reindexed (the cursor lives in Redis so restarts don't miss a boundary).
   */
  async refresh(now = new Date()): Promise<{ variants: number }> {
    const since = new Date(
      (await this.redis.get(REFRESH_CURSOR_KEY)) ?? now.getTime() - 15 * 60_000,
    );
    const ids = await this.indexer.variantsWithBoundaries(since, now);
    if (ids.length) await this.indexer.rebuild(ids);
    await this.redis.set(REFRESH_CURSOR_KEY, now.toISOString());
    return { variants: ids.length };
  }
}

@Injectable()
export class PriceIndexScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.PRICE_INDEX) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'price-index-refresh',
      { pattern: '*/5 * * * *', tz: 'UTC' },
      {
        name: JOBS.PRICE_INDEX_REFRESH,
        data: {},
        opts: { removeOnComplete: 50 },
      },
    );
  }
}
