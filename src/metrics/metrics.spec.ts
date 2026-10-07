import { request as httpRequest } from 'node:http';
import { register } from 'prom-client';
import { fakePrisma } from '../testing/fake-prisma.js';
import { BusinessMetricsListener } from './business-metrics.listener.js';
import { GaugesCollector } from './gauges.collector.js';
import { metricsAuthorized } from './metrics-auth.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsModule } from './metrics.module.js';
import { initMetrics, timeJob } from './metrics.js';
import { WorkerMetricsServer } from './worker-metrics.server.js';

/** Value of a series by its labels (all labels must match). */
async function value(name: string, labels: Record<string, string> = {}) {
  const m = register.getSingleMetric(name);
  if (!m) return undefined;
  const { values } = await m.get();
  return values.find((v) =>
    Object.entries(labels).every(([k, l]) => String(v.labels[k]) === l),
  )?.value;
}

describe('metrics basics', () => {
  it('checks the scrape token in constant time; no token = open', () => {
    expect(metricsAuthorized(undefined, undefined)).toBe(true);
    expect(metricsAuthorized('secret-token', 'Bearer secret-token')).toBe(true);
    expect(metricsAuthorized('secret-token', 'bearer secret-token')).toBe(true);
    expect(metricsAuthorized('secret-token', 'Bearer nope')).toBe(false);
    expect(metricsAuthorized('secret-token', undefined)).toBe(false);
  });

  it('times jobs by outcome', async () => {
    expect(await timeJob('q-test', 'ok', async () => 1)).toBe(1);
    await expect(
      timeJob('q-test', 'bad', async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    const m = await register
      .getSingleMetric('shop_queue_job_duration_seconds')!
      .get();
    const counts = m.values.filter(
      (v) =>
        (v as { metricName?: string }).metricName?.endsWith('_count') &&
        v.labels.queue === 'q-test',
    );
    expect(
      counts
        .map((c) => `${c.labels.name}:${c.labels.outcome}:${c.value}`)
        .sort(),
    ).toEqual(['bad:failed:1', 'ok:completed:1']);
  });

  it('labels everything with the process role and serves the registry', async () => {
    initMetrics('api');
    initMetrics('worker'); // first call wins
    const text = await register.metrics();
    expect(text).toContain('shop_process_cpu_user_seconds_total');
    expect(text).toContain('role="api"');
    expect(MetricsModule.forRole('api').controllers).toEqual([
      MetricsController,
    ]);
    expect(MetricsModule.forRole('worker').providers).toContain(
      WorkerMetricsServer,
    );
  });
});

describe('BusinessMetricsListener', () => {
  it('counts orders, payments, notifications and failed sign-ins', async () => {
    const l = new BusinessMetricsListener();
    const before =
      (await value('shop_orders_placed_total', { currency: 'USD' })) ?? 0;
    l.observe({
      name: 'order.placed',
      audit: { changes: { currency: 'USD', grandTotal: '6111' } },
    });
    l.observe({ name: 'order.placed', audit: { changes: {} } });
    l.observe({ name: 'order.paid' });
    l.observe({ name: 'payment.captured', data: { provider: 'STRIPE' } });
    l.observe({ name: 'payment.refund-failed', data: {} });
    l.observe({
      name: 'payment.webhook-received',
      data: { reason: 'invalid-signature' },
    });
    l.observe({ name: 'payment.webhook-received' });
    l.observe({ name: 'auth.login-failed' });
    l.observe({ name: 'customer.login-failed' });
    l.observe({ name: 'cart.updated' });
    l.observe(undefined as never);
    expect(await value('shop_orders_placed_total', { currency: 'USD' })).toBe(
      before + 1,
    );
    expect(
      await value('shop_orders_placed_total', { currency: 'unknown' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_orders_value_minor_total', { currency: 'USD' }),
    ).toBeGreaterThanOrEqual(6111);
    expect(
      await value('shop_order_events_total', { event: 'paid' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_payments_total', {
        provider: 'STRIPE',
        outcome: 'captured',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_payments_total', {
        provider: 'unknown',
        outcome: 'refund-failed',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_payment_webhooks_total', {
        result: 'invalid-signature',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_auth_failures_total', { realm: 'admin' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('shop_auth_failures_total', { realm: 'customer' }),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('GaugesCollector', () => {
  function setup() {
    const prisma = fakePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ backlog: 3n, dead: 1n, oldest: 42.5 }])
      .mockResolvedValueOnce([{ running: 2n, oldest: null }]);
    prisma.webhookDelivery.count.mockResolvedValue(4);
    prisma.webhook.count.mockResolvedValue(1);
    prisma.payment.count.mockResolvedValue(5);
    prisma.refund.count.mockResolvedValue(6);
    const queue = {
      getJobCounts: vi.fn(async () => ({
        waiting: 7,
        active: 1,
        delayed: 0,
        failed: 2,
      })),
    };
    const moduleRef = { get: vi.fn(() => queue) };
    const c = new GaugesCollector(prisma as never, moduleRef as never);
    c.onModuleInit();
    return { c, prisma, queue };
  }

  it('reports backlogs at scrape time, reading the database at most every 10 s', async () => {
    const { prisma } = setup();
    expect(
      await value('shop_queue_jobs', { queue: 'jobs', state: 'waiting' }),
    ).toBe(7);
    expect(
      await value('shop_queue_jobs', { queue: 'checkout', state: 'failed' }),
    ).toBe(2);
    expect(await value('shop_outbox_backlog')).toBe(3);
    expect(await value('shop_outbox_dead_letters')).toBe(1);
    expect(await value('shop_outbox_oldest_seconds')).toBe(42.5);
    expect(await value('shop_job_executions_running')).toBe(2);
    expect(await value('shop_job_executions_queued_oldest_seconds')).toBe(0);
    expect(await value('shop_webhook_deliveries_pending')).toBe(4);
    expect(await value('shop_webhooks_disabled')).toBe(1);
    expect(await value('shop_payments_pending_stale')).toBe(5);
    expect(await value('shop_refunds_pending')).toBe(6);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('a failed read is retried on the next scrape; registering twice replaces the gauges', async () => {
    const { c, prisma } = setup();
    prisma.$queryRaw.mockReset().mockRejectedValueOnce(new Error('db down'));
    await expect(c.snapshot(Date.now() + 60_000)).rejects.toThrow('db down');
    prisma.$queryRaw.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]);
    const s = await c.snapshot(Date.now() + 120_000);
    expect(s.outboxBacklog).toBe(0);
    expect(() => setup()).not.toThrow();
  });
});

describe('metrics endpoints', () => {
  it('the API endpoint needs the token when one is set', async () => {
    const ctrl = new MetricsController({
      get: () => ({ token: 'secret-token' }),
    } as never);
    await expect(ctrl.metrics('Bearer nope')).rejects.toThrow(
      'valid metrics token',
    );
    expect(await ctrl.metrics('Bearer secret-token')).toContain('# HELP');
  });

  it('the worker serves /metrics and /health on its own port', async () => {
    const cfg = (role: string, workerPort: number) =>
      ({
        get: (k: string) =>
          k === 'processRole' ? role : { workerPort, token: 'secret-token' },
      }) as never;
    const off = new WorkerMetricsServer(cfg('api', 0));
    await off.onApplicationBootstrap();
    await off.onApplicationShutdown();
    const port = 39_000 + Math.floor(Math.random() * 1000);
    const s = new WorkerMetricsServer(cfg('worker', port));
    await s.onApplicationBootstrap();
    const get = (path: string, auth?: string, method = 'GET') =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: auth ? { authorization: auth } : {},
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await get('/health')).toEqual({
      status: 200,
      body: '{"status":"ok"}',
    });
    expect((await get('/metrics')).status).toBe(401);
    const ok = await get('/metrics?x=1', 'Bearer secret-token');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('shop_');
    expect((await get('/other')).status).toBe(404);
    expect((await get('/metrics', undefined, 'POST')).status).toBe(404);
    await s.onApplicationShutdown();
  });
});
