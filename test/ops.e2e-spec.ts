/**
 * Phase 7: jobs and executions (cron definitions, run now), CSV exports downloaded from storage,
 * CSV imports with row errors, signed outgoing webhooks (switched off on 410 Gone), the audit log
 * written once per event, and the Prometheus endpoint. Real API + worker against PostgreSQL,
 * password-protected Redis and MinIO.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { eventually, rootToken, startApp, startWorker } from './support/app.js';
import { startStack, type TestStack } from './support/stack.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const METRICS_TOKEN = 'e2e-metrics-token-0123456789';

describe('Ops: jobs, imports/exports, webhooks, audit, metrics (e2e)', () => {
  let stack: TestStack;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let token: string;
  const id: Record<string, string> = {};

  // A webhook receiver: records requests, answers with `status`.
  let receiver: Server;
  let receiverUrl: string;
  let status = 200;
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];

  const http = () => request(app.getHttpServer());
  const admin = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) => {
    const r = http()
      [method](`/api/v1/admin${path}`)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  };
  const execution = (executionId: string) =>
    eventually(
      () => admin('get', `/job-executions/${executionId}`).expect(200),
      (r) => ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(r.body.status),
      30_000,
    );
  const importCsv = (type: string, csv: string, params?: object) => {
    const r = http()
      .post('/api/v1/admin/imports')
      .auth(token, { type: 'bearer' })
      .field('type', type)
      .attach('file', Buffer.from(csv, 'utf8'), 'data.csv');
    return params ? r.field('params', JSON.stringify(params)) : r;
  };

  beforeAll(async () => {
    stack = await startStack();
    Object.assign(process.env, {
      METRICS_TOKEN,
      // The receiver runs on localhost.
      WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
    });
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/shop`;

    app = await startApp();
    worker = await startWorker(['jobs', 'notifications']);
    token = await rootToken(app);

    id.us = (
      await admin('post', '/websites', {
        code: 'us',
        name: 'US',
        baseCurrencyCode: 'USD',
      }).expect(201)
    ).body.id;
    for (const [sku, name] of [
      ['TEE', 'Tee'],
      ['MUG', 'Mug'],
    ])
      await admin('post', '/products', {
        sku,
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name }],
        websiteIds: [id.us],
      }).expect(201);
    id.book = (
      await admin('post', '/price-books', {
        code: 'us-retail',
        name: 'US retail',
        currencyCode: 'USD',
        websiteId: id.us,
      }).expect(201)
    ).body.id;
    id.source = (
      await admin('post', '/inventory/sources', {
        code: 'main',
        name: 'Main',
        countryCode: 'US',
      }).expect(201)
    ).body.id;
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await new Promise<void>((r) => receiver?.close(() => r()));
    await stack?.stop();
  });

  describe('jobs', () => {
    it('lists job types and keeps one cron scheduler per active job', async () => {
      const types = (await admin('get', '/jobs/types').expect(200))
        .body as Body[];
      expect(types.map((t) => t.type)).toEqual(
        expect.arrayContaining([
          'export.products',
          'export.orders',
          'export.customers',
          'export.audit-log',
          'import.prices',
          'import.stock',
          'import.products',
          'search.reindex',
          'prices.reindex',
          'url-rewrites.rebuild',
        ]),
      );
      const job = (
        await admin('post', '/jobs', {
          code: 'nightly-orders',
          name: 'Nightly orders export',
          type: 'export.orders',
          params: { sinceHours: 24 },
          cron: '0 2 * * *',
          timezone: 'Asia/Ho_Chi_Minh',
        }).expect(201)
      ).body;
      expect(job.nextRunAt).toBeTruthy();
      const queue = worker.get<Queue>(getQueueToken('jobs'), { strict: false });
      const schedulers = () =>
        queue.getJobSchedulers(0, -1).then((s) => s.map((x) => x.key));
      await eventually(schedulers, (s) => s.includes(`job:${job.id}`));
      expect((await queue.getJobScheduler(`job:${job.id}`))?.pattern).toBe(
        '0 2 * * *',
      );
      await admin('patch', `/jobs/${job.id}`, { isActive: false }).expect(200);
      expect(
        await eventually(schedulers, (s) => !s.includes(`job:${job.id}`)),
      ).not.toContain(`job:${job.id}`);
      // Refused definitions.
      await admin('post', '/jobs', {
        code: 'bad',
        name: 'x',
        type: 'export.orders',
        cron: '0 2 * *',
      }).expect(400);
      await admin('post', '/jobs', {
        code: 'bad',
        name: 'x',
        type: 'import.prices',
      }).expect(400);
      await admin('post', '/jobs', {
        code: 'bad',
        name: 'x',
        type: 'export.orders',
        params: { sinceHours: 'x' },
      }).expect(400);
      await admin('post', '/jobs', {
        code: 'nightly-orders',
        name: 'dup',
        type: 'export.orders',
      }).expect(409);
      // "Run now" queues an execution of the defined job.
      const run = (await admin('post', `/jobs/${job.id}/run`).expect(202)).body;
      expect(run).toMatchObject({
        jobId: job.id,
        trigger: 'MANUAL',
        status: 'QUEUED',
      });
      expect((await execution(run.id)).body).toMatchObject({
        status: 'SUCCEEDED',
        stats: { rows: 0 },
        outputName: expect.stringMatching(/^orders-/),
      });
      const listed = (
        await admin('get', `/job-executions?jobId=${job.id}`).expect(200)
      ).body;
      expect(listed.total).toBe(1);
      expect(
        (await admin('get', `/jobs/${job.id}`).expect(200)).body.lastRunAt,
      ).toBeTruthy();
    });

    it('exports a CSV that can be downloaded with a short-lived link', async () => {
      const e = (
        await admin('post', '/job-executions', {
          type: 'export.products',
        }).expect(202)
      ).body;
      const done = (await execution(e.id)).body;
      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        progress: 100,
        stats: { rows: 2 },
      });
      const link = (
        await admin('get', `/job-executions/${e.id}/download`).expect(200)
      ).body;
      expect(link.name).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
      const res = await fetch(link.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain(link.name);
      // UTF-8 with a BOM, so spreadsheets read accents (res.text() would strip it).
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      const text = bytes.toString('utf8');
      expect(text).toContain('sku,type,status');
      expect(text).toContain('TEE,SIMPLE,ENABLED');
      await admin('post', `/job-executions/${e.id}/cancel`).expect(409);
      await admin('post', '/job-executions', { type: 'import.prices' }).expect(
        400,
      );
    });
  });

  describe('imports', () => {
    it('imports prices, reporting the rows it could not use', async () => {
      const e = (
        await importCsv(
          'import.prices',
          [
            'sku,price,compare_at_price',
            'TEE,25.00,30',
            'MUG,10,',
            'NOPE,1,',
            'TEE,1.234,',
          ].join('\n'),
          { priceBook: 'us-retail' },
        ).expect(202)
      ).body;
      const done = (await execution(e.id)).body;
      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        stats: { rows: 4, upserted: 2, failed: 2 },
      });
      expect(done.errors).toEqual([
        { row: 4, message: 'Unknown SKU NOPE' },
        {
          row: 5,
          message:
            'price must be a non-negative amount with at most 2 decimals',
        },
      ]);
      const entries = (
        await admin('get', `/price-books/${id.book}/entries`).expect(200)
      ).body.data as Body[];
      expect(
        entries.map((x) => [x.sku, x.amount, x.compareAtAmount]).sort(),
      ).toEqual([
        ['MUG', 1000, null],
        ['TEE', 2500, 3000],
      ]);
      // The prices were written as the admin who started the import (audit log).
      const audit = (
        await admin(
          'get',
          `/audit-logs?entityType=price_book&entityId=${id.book}&action=price-book.entries-changed`,
        ).expect(200)
      ).body;
      expect(audit.data[0].actorLabel).toBe('root@shop.test');
    });

    it('imports stock idempotently; a broken file fails with the reason', async () => {
      const csv = 'source,sku,quantity,safety_stock\nmain,TEE,40,2\n';
      const first = (
        await execution(
          (await importCsv('import.stock', csv).expect(202)).body.id,
        )
      ).body;
      expect(first.stats).toEqual({
        rows: 1,
        updated: 1,
        unchanged: 0,
        failed: 0,
      });
      const stock = (await admin('get', '/inventory/stock?sku=TEE').expect(200))
        .body.data[0];
      expect(stock).toMatchObject({
        sourceCode: 'main',
        quantity: 40,
        safetyStock: 2,
      });
      const again = (
        await execution(
          (await importCsv('import.stock', csv).expect(202)).body.id,
        )
      ).body;
      expect(again.stats).toEqual({
        rows: 1,
        updated: 0,
        unchanged: 1,
        failed: 0,
      });
      const broken = (
        await execution(
          (await importCsv('import.stock', 'sku,qty\nTEE,1\n').expect(202)).body
            .id,
        )
      ).body;
      expect(broken).toMatchObject({
        status: 'FAILED',
        error: 'Missing columns: quantity',
      });
      await importCsv('export.products', csv).expect(400);
      await importCsv('import.stock', csv, { source: 'nowhere' }).expect(400);
    });
  });

  describe('webhooks and audit', () => {
    let secret: string;
    let webhookId: string;
    const verify = (r: { headers: IncomingHttpHeaders; body: string }) => {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
        String(r.headers['x-shop-signature']),
      )!;
      return (
        createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') ===
        v1
      );
    };

    it('delivers subscribed events, signed, once', async () => {
      const w = (
        await admin('post', '/webhooks', {
          name: 'ERP',
          url: receiverUrl,
          events: ['product.*', 'job-execution.succeeded'],
        }).expect(201)
      ).body;
      secret = w.secret;
      webhookId = w.id;
      expect(secret).toMatch(/^whsec_/);
      expect(
        (await admin('get', `/webhooks/${w.id}`).expect(200)).body.secret,
      ).toBeUndefined();
      await admin('post', '/webhooks', {
        name: 'x',
        url: receiverUrl,
        events: ['order.payed'],
      }).expect(400);

      const cap = (
        await admin('post', '/products', {
          sku: 'CAP',
          type: 'SIMPLE',
          translations: [{ localeCode: 'en-US', name: 'Cap' }],
          websiteIds: [id.us],
        }).expect(201)
      ).body;
      const hit = () =>
        received.find(
          (r) =>
            JSON.parse(r.body).type === 'product.created' &&
            JSON.parse(r.body).data.entityId === cap.id,
        );
      await eventually(async () => hit(), Boolean, 15_000);
      const r = hit()!;
      expect(verify(r)).toBe(true);
      expect(r.headers).toMatchObject({
        'x-shop-event': 'product.created',
        'content-type': 'application/json',
      });
      const payload = JSON.parse(r.body);
      expect(payload).toMatchObject({
        id: r.headers['x-shop-event-id'],
        type: 'product.created',
        data: { entityType: 'product', entityId: cap.id, productId: cap.id },
      });
      expect(r.body).not.toContain('root@shop.test');
      const deliveries = (
        await eventually(
          () => admin('get', `/webhooks/${w.id}/deliveries`).expect(200),
          (x) => x.body.data.some((d: Body) => d.status === 'SUCCEEDED'),
        )
      ).body.data as Body[];
      expect(
        deliveries.find((d) => d.eventName === 'product.created'),
      ).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 1,
        responseStatus: 200,
      });

      // The audit log records the product once (redeliveries are skipped by event id).
      const audit = (
        await admin(
          'get',
          `/audit-logs?entityType=product&entityId=${cap.id}`,
        ).expect(200)
      ).body;
      expect(
        audit.data.filter((a: Body) => a.action === 'product.created'),
      ).toHaveLength(1);

      // Ping, and job executions reach the subscriber too.
      await admin('post', `/webhooks/${w.id}/test`).expect(202);
      await eventually(
        async () =>
          received.find((x) => x.headers['x-shop-event'] === 'webhook.ping'),
        Boolean,
      );
      expect(
        verify(
          received.find((x) => x.headers['x-shop-event'] === 'webhook.ping')!,
        ),
      ).toBe(true);
      const e = (
        await admin('post', '/job-executions', {
          type: 'export.products',
        }).expect(202)
      ).body;
      await eventually(
        async () => received.find((x) => x.body.includes(e.id)),
        Boolean,
        20_000,
      );
    });

    it('a receiver answering 410 Gone switches the webhook off', async () => {
      status = 410;
      const before = received.length;
      await admin('post', '/products', {
        sku: 'HAT',
        type: 'SIMPLE',
        translations: [{ localeCode: 'en-US', name: 'Hat' }],
      }).expect(201);
      const w = await eventually(
        () => admin('get', `/webhooks/${webhookId}`).expect(200),
        (x) => x.body.isActive === false,
        15_000,
      );
      expect(w.body).toMatchObject({
        isActive: false,
        disabledReason: 'The receiver answered 410 Gone',
        consecutiveFailures: 1,
      });
      expect(received.length).toBe(before + 1);
      // Switched off: nothing more is sent until it is re-enabled.
      status = 200;
      await admin(
        'patch',
        '/products/' +
          (await admin('get', '/products?search=HAT').expect(200)).body.data[0]
            .id,
        { status: 'DISABLED' },
      ).expect(200);
      await new Promise((r) => setTimeout(r, 1500));
      expect(received.length).toBe(before + 1);
      const re = (
        await admin('patch', `/webhooks/${webhookId}`, {
          isActive: true,
        }).expect(200)
      ).body;
      expect(re).toMatchObject({
        isActive: true,
        consecutiveFailures: 0,
        disabledReason: null,
      });
      // The failed delivery can be sent again.
      const failed = (
        await admin(
          'get',
          `/webhooks/${webhookId}/deliveries?status=FAILED`,
        ).expect(200)
      ).body.data[0];
      await admin('post', `/webhook-deliveries/${failed.id}/redeliver`).expect(
        202,
      );
      await eventually(
        () =>
          admin(
            'get',
            `/webhooks/${webhookId}/deliveries?status=SUCCEEDED`,
          ).expect(200),
        (x) => x.body.data.some((d: Body) => d.id === failed.id),
        15_000,
      );
    });
  });

  describe('metrics', () => {
    it('serves Prometheus metrics to the token holder only', async () => {
      await http().get('/api/v1/metrics').expect(401);
      await http()
        .get('/api/v1/metrics')
        .auth('wrong', { type: 'bearer' })
        .expect(401);
      const res = await http()
        .get('/api/v1/metrics')
        .auth(METRICS_TOKEN, { type: 'bearer' })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toMatch(
        /shop_http_request_duration_seconds_bucket\{.*route="\/api\/v1\/admin\/products".*\}/,
      );
      expect(res.text).toMatch(
        /shop_queue_jobs\{.*queue="jobs".*state="waiting".*\}/,
      );
      expect(res.text).toMatch(
        /shop_job_executions_total\{.*type="export.products".*status="SUCCEEDED".*\}/,
      );
      expect(res.text).toMatch(
        /shop_webhook_deliveries_total\{.*outcome="succeeded".*\}/,
      );
      expect(res.text).toContain('shop_outbox_backlog');
      expect(res.text).toContain('shop_nodejs_eventloop_lag_p99_seconds');
      // Unmatched paths share one label (no cardinality blow-up from scanners).
      await http().get('/api/v1/wp-admin/setup-config.php').expect(404);
      const again = await http()
        .get('/api/v1/metrics')
        .auth(METRICS_TOKEN, { type: 'bearer' })
        .expect(200);
      expect(again.text).toMatch(/route="unmatched"/);
      expect(again.text).not.toContain('wp-admin');
    });
  });
});
