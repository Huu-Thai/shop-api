import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { ReservationsService } from './reservations.service.js';

@Processor(QUEUES.INVENTORY, { concurrency: 1 })
export class InventoryProcessor extends WorkerHost {
  constructor(private readonly reservations: ReservationsService) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.INVENTORY_EXPIRE_RESERVATIONS)
        return { expired: await this.reservations.expire() };
      if (job.name === JOBS.INVENTORY_RECONCILE)
        return this.reservations.reconcile();
      return { skipped: `unknown job ${job.name}` };
    });
  }
}

@Injectable()
export class InventoryScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.INVENTORY) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expire-reservations',
      { every: 60_000 },
      {
        name: JOBS.INVENTORY_EXPIRE_RESERVATIONS,
        data: {},
        opts: { removeOnComplete: 100 },
      },
    );
    await this.queue.upsertJobScheduler(
      'reconcile-reserved',
      { pattern: '45 3 * * *', tz: 'UTC' },
      {
        name: JOBS.INVENTORY_RECONCILE,
        data: {},
        opts: { removeOnComplete: 30 },
      },
    );
  }
}
