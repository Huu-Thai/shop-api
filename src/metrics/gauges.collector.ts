import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { Gauge, register } from 'prom-client';
import { PrismaService } from '../database/prisma.service.js';
import { ALL_QUEUES } from '../queue/queue.constants.js';

const STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
/** Scrapes come every 15 s or so; the database is asked at most this often. */
const CACHE_MS = 10_000;

interface Snapshot {
  queues: { queue: string; state: string; count: number }[];
  outboxBacklog: number;
  outboxDead: number;
  outboxOldestSeconds: number;
  executionsRunning: number;
  executionsQueuedOldestSeconds: number;
  webhookPending: number;
  webhooksDisabled: number;
  paymentsPendingOver15m: number;
  refundsPending: number;
}

/**
 * Backlog gauges read at scrape time (queues, outbox, executions, webhooks, payments). They describe
 * shared state, so every API replica reports the same values: use max() across instances.
 */
@Injectable()
export class GaugesCollector implements OnModuleInit {
  private readonly logger = new Logger(GaugesCollector.name);
  private cached?: { at: number; snap: Promise<Snapshot> };

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    const snapshot = () => this.snapshot();
    // A second app instance in the same process (tests) replaces the previous gauges.
    const gauge = <L extends string>(
      name: string,
      help: string,
      collect: (g: Gauge<L>, s: Snapshot) => void,
      labelNames: L[] = [],
    ) => {
      register.removeSingleMetric(name);
      new Gauge<L>({
        name,
        help,
        labelNames,
        async collect() {
          collect(this, await snapshot());
        },
      });
    };
    gauge(
      'shop_queue_jobs',
      'BullMQ jobs per queue and state',
      (g, s) => {
        for (const q of s.queues)
          g.set({ queue: q.queue, state: q.state }, q.count);
      },
      ['queue', 'state'],
    );
    const simple: [string, string, (s: Snapshot) => number][] = [
      [
        'shop_outbox_backlog',
        'After-events not yet delivered (outbox rows)',
        (s) => s.outboxBacklog,
      ],
      [
        'shop_outbox_dead_letters',
        'After-events parked after too many failed deliveries',
        (s) => s.outboxDead,
      ],
      [
        'shop_outbox_oldest_seconds',
        'Age of the oldest undelivered after-event',
        (s) => s.outboxOldestSeconds,
      ],
      [
        'shop_job_executions_running',
        'Job executions running',
        (s) => s.executionsRunning,
      ],
      [
        'shop_job_executions_queued_oldest_seconds',
        'Age of the oldest queued job execution',
        (s) => s.executionsQueuedOldestSeconds,
      ],
      [
        'shop_webhook_deliveries_pending',
        'Outgoing webhook deliveries waiting for (another) attempt',
        (s) => s.webhookPending,
      ],
      [
        'shop_webhooks_disabled',
        'Webhooks switched off after failures',
        (s) => s.webhooksDisabled,
      ],
      [
        'shop_payments_pending_stale',
        'Payments pending for more than 15 minutes (reconciliation lagging)',
        (s) => s.paymentsPendingOver15m,
      ],
      [
        'shop_refunds_pending',
        'Refunds the provider has not settled yet',
        (s) => s.refundsPending,
      ],
    ];
    for (const [name, help, pick] of simple)
      gauge(name, help, (g, s) => g.set(pick(s)));
  }

  snapshot(now = Date.now()): Promise<Snapshot> {
    if (!this.cached || now - this.cached.at > CACHE_MS)
      this.cached = {
        at: now,
        snap: this.read(now).catch((e: Error) => {
          this.logger.warn(`Metrics snapshot failed: ${e.message}`);
          this.cached = undefined;
          throw e;
        }),
      };
    return this.cached.snap;
  }

  private async read(now: number): Promise<Snapshot> {
    const queues = await Promise.all(
      ALL_QUEUES.map(async (name) => {
        const q = this.moduleRef.get<Queue>(getQueueToken(name), {
          strict: false,
        });
        const counts = await q.getJobCounts(...STATES);
        return STATES.map((state) => ({
          queue: name,
          state,
          count: counts[state] ?? 0,
        }));
      }),
    );
    const [outbox] = await this.prisma.$queryRaw<
      { backlog: bigint; dead: bigint; oldest: number | null }[]
    >`SELECT count(*) FILTER (WHERE failed_at IS NULL) AS backlog,
             count(*) FILTER (WHERE failed_at IS NOT NULL) AS dead,
             EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE failed_at IS NULL))::float8 AS oldest
        FROM outbox_events`;
    const [executions] = await this.prisma.$queryRaw<
      { running: bigint; oldest: number | null }[]
    >`SELECT count(*) FILTER (WHERE status = 'RUNNING') AS running,
             EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'QUEUED'))::float8 AS oldest
        FROM job_executions WHERE status IN ('QUEUED', 'RUNNING')`;
    const [webhookPending, webhooksDisabled, paymentsStale, refundsPending] =
      await Promise.all([
        this.prisma.webhookDelivery.count({ where: { status: 'PENDING' } }),
        this.prisma.webhook.count({
          where: { isActive: false, disabledReason: { not: null } },
        }),
        this.prisma.payment.count({
          where: {
            status: 'PENDING',
            providerCode: { not: 'COD' },
            createdAt: { lt: new Date(now - 15 * 60_000) },
          },
        }),
        this.prisma.refund.count({ where: { status: 'PENDING' } }),
      ]);
    return {
      queues: queues.flat(),
      outboxBacklog: Number(outbox?.backlog ?? 0),
      outboxDead: Number(outbox?.dead ?? 0),
      outboxOldestSeconds: Math.max(0, outbox?.oldest ?? 0),
      executionsRunning: Number(executions?.running ?? 0),
      executionsQueuedOldestSeconds: Math.max(0, executions?.oldest ?? 0),
      webhookPending,
      webhooksDisabled,
      paymentsPendingOver15m: paymentsStale,
      refundsPending,
    };
  }
}
