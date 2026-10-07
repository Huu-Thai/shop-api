import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import {
  matches,
  signature,
  unknownPatterns,
  webhookPayload,
  WEBHOOK_EVENTS_CATALOGUE,
} from './webhook-catalogue.js';
import { deliveryId, WebhookDispatcher } from './webhook-dispatcher.js';
import { isBlockedAddress, WebhookSender } from './webhook-sender.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksProcessor, WebhooksScheduler } from './webhooks.processor.js';
import { WebhooksService } from './webhooks.service.js';

const config = (extra: object = {}, env = 'development') => ({
  get: vi.fn((key: string) =>
    key === 'env'
      ? env
      : {
          timeoutMs: 2000,
          maxAttempts: 3,
          disableAfter: 2,
          retentionDays: 30,
          allowPrivateTargets: false,
          ...extra,
        },
  ),
});

describe('webhook catalogue', () => {
  it('matches exact names and prefix patterns; flags unknown ones', () => {
    expect(matches(['order.*'], 'order.paid')).toBe(true);
    expect(matches(['order.*'], 'payment.captured')).toBe(false);
    expect(matches(['payment.captured'], 'payment.captured')).toBe(true);
    expect(
      unknownPatterns([
        'order.*',
        'order.payed',
        'stock.*',
        'job-execution.failed',
      ]),
    ).toEqual(['order.payed', 'stock.*']);
  });

  it('covers storefront content, so storefront caches can follow publishing', () => {
    for (const name of [
      'page.published',
      'post.updated',
      'block-placement.created',
      'menu-item.updated',
      'slide.updated',
      'category.moved',
      'price-book.entries-changed',
    ])
      expect(WEBHOOK_EVENTS_CATALOGUE).toHaveProperty([name]);
    expect(unknownPatterns(['page.*', 'menu.*', 'slider.*'])).toEqual([]);
  });

  it('publishes ids, data and changed field names — never actors or values', () => {
    const p = webhookPayload({
      name: 'product.updated',
      eventId: 'ev1',
      occurredAt: new Date('2026-11-21T10:00:00Z'),
      entityType: 'product',
      entityId: 'p1',
      actor: { type: 'admin', id: 'a1', label: 'root@shop.test' },
      audit: { changes: { status: { from: 'ENABLED', to: 'DISABLED' } } },
      data: { productId: 'p1', urlsChanged: false },
    } as never);
    expect(p).toEqual({
      id: 'ev1',
      type: 'product.updated',
      createdAt: '2026-11-21T10:00:00.000Z',
      data: {
        entityType: 'product',
        entityId: 'p1',
        productId: 'p1',
        urlsChanged: false,
        changedFields: ['status'],
      },
    });
    expect(JSON.stringify(p)).not.toContain('root@shop.test');
    expect(
      webhookPayload({
        name: 'inventory.changed',
        eventId: 'e',
        occurredAt: new Date(0),
        data: { variantIds: ['v'] },
      } as never).data,
    ).toEqual({ variantIds: ['v'] });
  });

  it('signs "<t>.<body>" with HMAC-SHA256', () => {
    const at = 1_800_000_000_123;
    const sig = signature('whsec_x', '{"a":1}', at);
    const v1 = createHmac('sha256', 'whsec_x')
      .update('1800000000.{"a":1}')
      .digest('hex');
    expect(sig).toBe(`t=1800000000,v1=${v1}`);
  });
});

describe('WebhookSender', () => {
  let server: Server;
  let url: string;
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  let reply = { status: 200, body: 'ok' };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/' });
          res.end();
          return;
        }
        if (req.url === '/slow') return; // never answers
        res.writeHead(reply.status);
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('knows private and special addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'nonsense',
    ])
      expect(isBlockedAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
      expect(isBlockedAddress(a)).toBe(false);
  });

  it('posts JSON with the headers and reports the answer (allowed private targets)', async () => {
    const s = new WebhookSender(config({ allowPrivateTargets: true }) as never);
    reply = { status: 200, body: 'thanks' };
    const r = await s.send(`${url}/hook`, '{"a":1}', {
      'x-shop-event': 'order.paid',
    });
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      body: 'thanks',
      error: null,
    });
    expect(seen.at(-1)).toMatchObject({
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'shop-webhooks/1',
        'x-shop-event': 'order.paid',
      },
    });
    reply = { status: 500, body: 'x'.repeat(5000) };
    const bad = await s.send(`${url}/hook`, '{}', {});
    expect(bad).toMatchObject({ ok: false, status: 500 });
    expect(bad.body).toHaveLength(1000);
    const moved = await s.send(`${url}/redirect`, '{}', {});
    expect(moved).toMatchObject({ ok: false, status: 302 });
    expect(
      seen.filter((x) => x.headers.host?.toString().startsWith('169.254')),
    ).toHaveLength(0);
    await s.onModuleDestroy();
  });

  it('refuses private targets by name and by literal, and times out', async () => {
    const s = new WebhookSender(config() as never);
    const byName = await s.send(`${url}/hook`, '{}', {});
    expect(byName).toMatchObject({ ok: false, status: null });
    expect(byName.error).toContain('private address');
    const literal = await s.send('http://127.0.0.1:9/hook', '{}', {});
    expect(literal.error).toBe(
      "127.0.0.1 is a private address; webhooks can't reach internal networks",
    );
    expect((await s.send('http://[::1]:9/hook', '{}', {})).error).toContain(
      'private address',
    );
    await s.onModuleDestroy();
    const fast = new WebhookSender(
      config({ allowPrivateTargets: true, timeoutMs: 200 }) as never,
    );
    const slow = await fast.send(`${url}/slow`, '{}', {});
    expect(slow).toMatchObject({ ok: false, status: null });
    await fast.onModuleDestroy();
  });
});

const hook = (extra = {}) => ({
  id: 'w1',
  name: 'ERP',
  url: 'https://erp.example/hook',
  events: ['order.*'],
  isActive: true,
  consecutiveFailures: 0,
  disabledReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

function service(env = 'development', extra: object = {}) {
  const prisma = fakePrisma();
  const b = fakeBus(prisma);
  const secrets = {
    seal: vi.fn(() => 'sealed'),
    open: vi.fn(() => ({ secret: 'whsec_x' })),
  };
  const queue = { add: vi.fn<AnyFn>() };
  const svc = new WebhooksService(
    prisma as never,
    b.bus,
    secrets as never,
    config(extra, env) as never,
    queue as never,
  );
  return { prisma, b, secrets, queue, svc };
}

describe('WebhooksService', () => {
  it('creates subscriptions with a one-time secret', async () => {
    const { svc, prisma, b, secrets } = service();
    prisma.webhook.create.mockImplementation(async (a: { data: object }) =>
      hook(a.data),
    );
    const w = await svc.create(
      {
        name: 'ERP',
        url: 'https://erp.example/hook',
        events: ['order.*', 'order.*'],
      },
      ROOT,
    );
    expect(w.secret).toMatch(/^whsec_[\w-]{32}$/);
    expect(secrets.seal).toHaveBeenCalledWith({ secret: w.secret });
    expect(prisma.webhook.create.mock.calls[0][0].data).toMatchObject({
      secret: 'sealed',
      events: ['order.*'],
      createdById: ROOT.id,
    });
    expect(b.afterNames()).toEqual(['webhook.created']);
    expect(svc.events().length).toBeGreaterThan(10);
  });

  it('refuses unsafe or unknown targets and events', async () => {
    const { svc } = service();
    const refused: [string, string][] = [
      ['not a url', 'not a valid URL'],
      ['ftp://x.example', 'must be http(s)'],
      ['https://user:pw@x.example', 'no credentials'],
      ['http://localhost:3000/x', 'private address'],
      ['http://api.shop.localhost/x', 'private address'],
      ['http://10.0.0.5/x', 'private address'],
      ['http://[fd00::1]/x', 'private address'],
    ];
    for (const [url, msg] of refused)
      await expect(
        svc.create({ name: 'x', url, events: ['order.paid'] }, ROOT),
      ).rejects.toThrow(msg);
    await expect(
      svc.create(
        { name: 'x', url: 'https://x.example', events: ['order.payed'] },
        ROOT,
      ),
    ).rejects.toThrow('Unknown event(s): order.payed');
    const prod = service('production');
    await expect(
      prod.svc.create(
        { name: 'x', url: 'http://x.example', events: ['order.paid'] },
        ROOT,
      ),
    ).rejects.toThrow('must be https');
    const dev = service('development', { allowPrivateTargets: true });
    dev.prisma.webhook.create.mockImplementation(async (a: { data: object }) =>
      hook(a.data),
    );
    await expect(
      dev.svc.create(
        { name: 'x', url: 'http://localhost:4000/x', events: ['order.paid'] },
        ROOT,
      ),
    ).resolves.toBeDefined();
  });

  it('updates (re-enabling resets failures), rotates secrets, deletes', async () => {
    const { svc, prisma, b } = service();
    prisma.webhook.findUnique.mockResolvedValue(
      hook({ isActive: false, consecutiveFailures: 20, disabledReason: 'x' }),
    );
    prisma.webhook.update.mockImplementation(async (a: { data: object }) =>
      hook(a.data),
    );
    await svc.update('w1', { isActive: true, events: ['payment.*'] }, ROOT);
    expect(prisma.webhook.update.mock.calls[0][0].data).toMatchObject({
      isActive: true,
      consecutiveFailures: 0,
      disabledReason: null,
      events: ['payment.*'],
    });
    prisma.webhook.findUnique.mockResolvedValue(hook());
    prisma.webhook.update.mockResolvedValue(hook());
    await svc.update('w1', { name: 'ERP' }, ROOT);
    expect(b.afterNames()).toEqual(['webhook.updated']);
    const r = await svc.rotateSecret('w1', ROOT);
    expect(r.secret).toMatch(/^whsec_/);
    await svc.remove('w1', ROOT);
    expect(b.afterNames()).toEqual([
      'webhook.updated',
      'webhook.secret-rotated',
      'webhook.deleted',
    ]);
    prisma.webhook.findUnique.mockResolvedValue(null);
    await expect(svc.get('w9')).rejects.toThrow('not found');
    prisma.webhook.findMany.mockResolvedValue([hook()]);
    expect(await svc.list()).toHaveLength(1);
  });

  it('tests, lists and redelivers deliveries (each a message with retries)', async () => {
    const { svc, prisma, queue } = service();
    prisma.webhook.findUnique.mockResolvedValue(hook());
    prisma.webhookDelivery.create.mockImplementation(
      async (a: { data: object }) => ({ id: 'd1', ...a.data }),
    );
    const d = await svc.test('w1', ROOT);
    expect(d).toMatchObject({
      eventName: 'webhook.ping',
      payload: { type: 'webhook.ping', data: { webhookId: 'w1' } },
    });
    expect(queue.add).toHaveBeenCalledWith(
      'webhook-deliver',
      { deliveryId: 'd1' },
      expect.objectContaining({
        jobId: 'd1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }),
    );
    prisma.webhookDelivery.count.mockResolvedValue(0);
    await svc.deliveries('w1', {
      page: 1,
      limit: 10,
      skip: 0,
      order: 'desc',
      status: 'FAILED',
    } as never);
    expect(prisma.webhookDelivery.findMany.mock.calls[0][0].where).toEqual({
      webhookId: 'w1',
      status: 'FAILED',
    });
    prisma.webhookDelivery.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.webhookDelivery.findUniqueOrThrow.mockResolvedValue({ id: 'd1' });
    await svc.redeliver('d1', ROOT);
    expect(queue.add.mock.calls[1][2].jobId).toMatch(/^d1-r\d+$/);
    await expect(svc.redeliver('d9', ROOT)).rejects.toThrow('not found');
  });
});

describe('WebhookDispatcher', () => {
  it('creates one delivery per subscribed webhook and event, idempotently', async () => {
    const { svc, prisma, b, queue } = service();
    const d = new WebhookDispatcher(prisma as never, b.bus, svc);
    prisma.webhook.findMany.mockResolvedValue([
      { id: 'w1', events: ['order.*'] },
      { id: 'w2', events: ['payment.captured'] },
    ]);
    prisma.webhookDelivery.createMany.mockResolvedValue({ count: 1 });
    const event = {
      name: 'order.paid',
      eventId: 'ev1',
      occurredAt: new Date(),
      entityType: 'order',
      entityId: 'o1',
      data: { orderId: 'o1' },
    };
    await d.onEvent(event as never);
    const rows = prisma.webhookDelivery.createMany.mock.calls[0][0];
    expect(rows.skipDuplicates).toBe(true);
    expect(rows.data).toEqual([
      expect.objectContaining({
        id: deliveryId('w1', 'ev1'),
        webhookId: 'w1',
        eventName: 'order.paid',
      }),
    ]);
    expect(queue.add.mock.calls[0][2].jobId).toBe(deliveryId('w1', 'ev1'));
    expect(deliveryId('w1', 'ev1')).toBe(deliveryId('w1', 'ev1'));
    // Cached subscriptions; a webhook change in this process refreshes them.
    await d.onEvent({ ...event, eventId: 'ev2' } as never);
    expect(prisma.webhook.findMany).toHaveBeenCalledTimes(1);
    d.invalidate();
    await d.onEvent({
      name: 'customer.registered',
      eventId: 'ev3',
      occurredAt: new Date(),
    } as never);
    expect(prisma.webhook.findMany).toHaveBeenCalledTimes(2);
    // Not in the catalogue, or not from the outbox: ignored.
    await d.onEvent({
      name: 'cart.updated',
      eventId: 'x',
      occurredAt: new Date(),
    } as never);
    await d.onEvent({ name: 'order.paid', occurredAt: new Date() } as never);
    await d.onEvent(undefined as never);
    expect(prisma.webhookDelivery.createMany).toHaveBeenCalledTimes(2);
  });
});

describe('WebhooksProcessor', () => {
  function setup(sendResult: object, webhook: object = {}) {
    const prisma = fakePrisma();
    const b = fakeBus(prisma);
    const secrets = { open: vi.fn(() => ({ secret: 'whsec_x' })) };
    const sender = {
      send: vi.fn<AnyFn>(async () => ({
        ok: true,
        status: 200,
        body: 'ok',
        error: null,
        durationMs: 12,
        ...sendResult,
      })),
    };
    prisma.webhookDelivery.findUnique.mockResolvedValue({
      id: 'd1',
      eventId: 'ev1',
      eventName: 'order.paid',
      payload: { id: 'ev1', type: 'order.paid' },
      status: 'PENDING',
      webhook: {
        id: 'w1',
        url: 'https://erp.example/hook',
        secret: 'sealed',
        isActive: true,
        ...webhook,
      },
    });
    prisma.webhook.update.mockResolvedValue({
      consecutiveFailures: 1,
      isActive: true,
    });
    const p = new WebhooksProcessor(
      prisma as never,
      b.bus,
      secrets as never,
      sender as never,
      config() as never,
    );
    return { prisma, b, sender, p };
  }
  const job = (attemptsMade = 0, attempts = 3, name = 'webhook-deliver') =>
    ({
      id: '1',
      name,
      data: { deliveryId: 'd1' },
      attemptsMade,
      opts: { attempts },
      queueName: 'notifications',
    }) as never;

  it('delivers signed payloads and resets the failure count', async () => {
    const { p, sender, prisma } = setup({});
    expect(await p.process(job())).toEqual({ status: 200, durationMs: 12 });
    const [url, body, headers] = sender.send.mock.calls[0];
    expect(url).toBe('https://erp.example/hook');
    expect(body).toBe('{"id":"ev1","type":"order.paid"}');
    expect(headers).toMatchObject({
      'x-shop-event': 'order.paid',
      'x-shop-event-id': 'ev1',
      'x-shop-delivery': 'd1',
    });
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      headers['x-shop-signature'],
    )!;
    expect(v1).toBe(
      createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex'),
    );
    expect(prisma.webhookDelivery.update.mock.calls[0][0].data).toMatchObject({
      status: 'SUCCEEDED',
      responseStatus: 200,
      attempts: { increment: 1 },
    });
    expect(prisma.webhook.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'w1', consecutiveFailures: { gt: 0 } },
      data: { consecutiveFailures: 0 },
    });
  });

  it('retries failures with backoff, then fails and counts towards switching off', async () => {
    const s = setup({ ok: false, status: 503, body: 'down' });
    await expect(s.p.process(job(0, 3))).rejects.toThrow(
      'answered 503 (attempt 1/3)',
    );
    expect(s.prisma.webhookDelivery.update.mock.calls[0][0].data).toMatchObject(
      { status: 'PENDING', nextAttemptAt: expect.any(Date) },
    );
    expect(await s.p.process(job(2, 3))).toEqual({ failed: 503 });
    expect(s.prisma.webhookDelivery.update.mock.calls[1][0].data).toMatchObject(
      { status: 'FAILED', nextAttemptAt: null },
    );
    expect(s.prisma.webhook.update.mock.calls[0][0].data).toEqual({
      consecutiveFailures: { increment: 1 },
    });
    expect(s.b.afterNames()).toEqual([]);
    // The second delivery failing in a row switches it off (WEBHOOK_DISABLE_AFTER = 2 here).
    s.prisma.webhook.update.mockResolvedValueOnce({
      consecutiveFailures: 2,
      isActive: true,
    });
    await s.p.process(job(2, 3));
    expect(s.prisma.webhook.update.mock.calls.at(-1)![0].data).toEqual({
      isActive: false,
      disabledReason: '2 deliveries failed in a row',
    });
    expect(s.b.afterNames()).toEqual(['webhook.disabled']);
  });

  it('410 Gone switches the webhook off at once; network errors retry', async () => {
    const gone = setup({ ok: false, status: 410, body: '' });
    expect(await gone.p.process(job(0, 3))).toEqual({ failed: 410 });
    expect(gone.b.afterNames()).toEqual(['webhook.disabled']);
    const net = setup({
      ok: false,
      status: null,
      body: null,
      error: 'ECONNREFUSED',
    });
    await expect(net.p.process(job(0, 3))).rejects.toThrow(
      'answered ECONNREFUSED',
    );
  });

  it('skips delivered or removed deliveries and switched-off webhooks; purges old ones', async () => {
    const off = setup({}, { isActive: false });
    expect(await off.p.process(job())).toEqual({
      skipped: 'webhook switched off',
    });
    expect(
      off.prisma.webhookDelivery.update.mock.calls[0][0].data,
    ).toMatchObject({ status: 'FAILED', error: 'The webhook is switched off' });
    expect(off.sender.send).not.toHaveBeenCalled();
    off.prisma.webhookDelivery.findUnique.mockResolvedValueOnce({
      status: 'SUCCEEDED',
    });
    expect(await off.p.process(job())).toEqual({
      skipped: 'already delivered',
    });
    off.prisma.webhookDelivery.findUnique.mockResolvedValueOnce(null);
    expect(await off.p.process(job())).toEqual({ skipped: 'delivery removed' });
    off.prisma.$executeRaw.mockResolvedValueOnce(5000).mockResolvedValueOnce(1);
    expect(await off.p.process(job(0, 1, 'webhooks-purge'))).toEqual({
      purged: 5001,
    });
    expect(await off.p.process(job(0, 1, 'other'))).toEqual({
      skipped: 'unknown job other',
    });
    const queue = { upsertJobScheduler: vi.fn() };
    await new WebhooksScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler.mock.calls[0][0]).toBe(
      'purge-webhook-deliveries',
    );
  });

  it('the controller delegates every route', async () => {
    expect(
      await exerciseController(new WebhooksController(stubService() as never)),
    ).toEqual({ ok: 10, failed: 0 });
  });
});
