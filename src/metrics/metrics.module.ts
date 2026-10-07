import { type DynamicModule, Module } from '@nestjs/common';
import { BusinessMetricsListener } from './business-metrics.listener.js';
import { GaugesCollector } from './gauges.collector.js';
import { initMetrics } from './metrics.js';
import { MetricsController } from './metrics.controller.js';
import { WorkerMetricsServer } from './worker-metrics.server.js';

/**
 * Prometheus metrics. The API serves `/api/v1/metrics` with the shared backlog gauges; workers
 * serve their own process and job metrics on WORKER_METRICS_PORT.
 */
@Module({})
export class MetricsModule {
  static forRole(role: 'api' | 'worker'): DynamicModule {
    initMetrics(role);
    return role === 'api'
      ? {
          module: MetricsModule,
          controllers: [MetricsController],
          providers: [BusinessMetricsListener, GaugesCollector],
        }
      : {
          module: MetricsModule,
          providers: [BusinessMetricsListener, WorkerMetricsServer],
        };
  }
}
