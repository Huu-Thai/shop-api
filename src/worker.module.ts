import { SearchProcessor } from './modules/search/search.processor.js';
import {
  type DynamicModule,
  Logger,
  Module,
  type Provider,
} from '@nestjs/common';
import { CORE_IMPORTS, DOMAIN_IMPORTS } from './app.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import {
  InventoryProcessor,
  InventoryScheduler,
} from './modules/inventory/inventory.processor.js';
import { MediaProcessor } from './modules/media/media.processor.js';
import {
  PriceIndexProcessor,
  PriceIndexScheduler,
} from './modules/pricing/price-index.processor.js';
import { CatalogProcessor } from './modules/url-rewrites/url-rewrites.processor.js';
import {
  MaintenanceProcessor,
  MaintenanceScheduler,
} from './modules/maintenance/maintenance.processor.js';
import {
  SchedulerBootstrap,
  SchedulerProcessor,
} from './modules/scheduler/scheduler.processor.js';
import {
  CheckoutJobsProcessor,
  CheckoutJobsScheduler,
} from './modules/payments/checkout-jobs.processor.js';
import { CouponsProcessor } from './modules/marketing/coupons.processor.js';
import {
  LoyaltyProcessor,
  LoyaltyScheduler,
} from './modules/loyalty/loyalty.processor.js';
import { JobsProcessor, JobsScheduler } from './modules/jobs/jobs.processor.js';
import {
  WebhooksProcessor,
  WebhooksScheduler,
} from './modules/webhooks/webhooks.processor.js';
import { ALL_QUEUES, QUEUES, type QueueName } from './queue/queue.constants.js';

/** Processors per queue; later phases add theirs here. */
export const PROCESSORS: Partial<Record<QueueName, Provider[]>> = {
  [QUEUES.MAINTENANCE]: [MaintenanceProcessor, MaintenanceScheduler],
  [QUEUES.MEDIA]: [MediaProcessor],
  [QUEUES.CATALOG]: [CatalogProcessor],
  [QUEUES.PRICE_INDEX]: [PriceIndexProcessor, PriceIndexScheduler],
  [QUEUES.INVENTORY]: [InventoryProcessor, InventoryScheduler],
  [QUEUES.SEARCH_INDEX]: [SearchProcessor],
  [QUEUES.SCHEDULER]: [SchedulerProcessor, SchedulerBootstrap],
  [QUEUES.COUPONS]: [CouponsProcessor],
  [QUEUES.LOYALTY]: [LoyaltyProcessor, LoyaltyScheduler],
  [QUEUES.CHECKOUT]: [CheckoutJobsProcessor, CheckoutJobsScheduler],
  [QUEUES.JOBS]: [JobsProcessor, JobsScheduler],
  [QUEUES.NOTIFICATIONS]: [WebhooksProcessor, WebhooksScheduler],
};

/**
 * Worker process root. WORKER_QUEUES (comma separated; empty = all) selects which processors
 * this process runs, so each deployment scales one queue group independently.
 */
@Module({})
export class WorkerModule {
  static forQueues(queues: string[]): DynamicModule {
    const unknown = queues.filter((q) => !(ALL_QUEUES as string[]).includes(q));
    if (unknown.length)
      throw new Error(
        `WORKER_QUEUES contains unknown queues: ${unknown.join(', ')} (known: ${ALL_QUEUES.join(', ')})`,
      );
    const selected = Object.entries(PROCESSORS)
      .filter(([q]) => queues.length === 0 || queues.includes(q))
      .flatMap(([, p]) => p!);
    new Logger('WorkerModule').log(
      `Processors: ${queues.length ? queues.join(', ') : 'all queues'}`,
    );
    return {
      module: WorkerModule,
      imports: [
        ...CORE_IMPORTS,
        ...DOMAIN_IMPORTS,
        MetricsModule.forRole('worker'),
      ],
      providers: selected,
    };
  }
}
