import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { withJobContext } from '../../common/utils/job-context.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { CartsService } from '../carts/carts.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PaymentsService } from './payments.service.js';

/** Checkout housekeeping on the `checkout` queue. */
@Processor(QUEUES.CHECKOUT, { concurrency: 1 })
export class CheckoutJobsProcessor extends WorkerHost {
  constructor(
    private readonly carts: CartsService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      switch (job.name) {
        case JOBS.CARTS_PURGE:
          return { purged: await this.carts.purge() };
        case JOBS.ORDERS_EXPIRE_UNPAID:
          return { canceled: await this.orders.expireUnpaid() };
        case JOBS.PAYMENTS_RECONCILE:
          return this.payments.reconcile();
        default:
          return { skipped: `unknown job ${job.name}` };
      }
    });
  }
}

/** Unpaid orders every 5 minutes, payment reconciliation every 10, cart purge daily. */
@Injectable()
export class CheckoutJobsScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.CHECKOUT) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expire-unpaid-orders',
      { every: 5 * 60_000 },
      {
        name: JOBS.ORDERS_EXPIRE_UNPAID,
        data: {},
        opts: { removeOnComplete: 100 },
      },
    );
    await this.queue.upsertJobScheduler(
      'reconcile-payments',
      { every: 10 * 60_000 },
      {
        name: JOBS.PAYMENTS_RECONCILE,
        data: {},
        opts: { removeOnComplete: 100 },
      },
    );
    await this.queue.upsertJobScheduler(
      'purge-carts',
      { pattern: '0 4 * * *', tz: 'UTC' },
      { name: JOBS.CARTS_PURGE, data: {}, opts: { removeOnComplete: 30 } },
    );
  }
}
