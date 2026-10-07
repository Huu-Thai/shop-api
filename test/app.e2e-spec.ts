/**
 * Boots the real application (same HTTP pipeline as main.ts) against real PostgreSQL,
 * password-protected Redis and MinIO. Phase 0 "done": health is green with authenticated
 * Redis, and admin auth / RBAC / API keys / audit work end to end.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import {
  breakingChanges,
  contractProblems,
  storefrontContract,
} from '../src/common/openapi/storefront-contract.js';
import { untypedProperties } from '../src/common/openapi/schema-lint.js';
import { REDIS_PASSWORD, startStack, type TestStack } from './support/stack.js';

const CONTRACT_FILE = new URL('../openapi/storefront.json', import.meta.url);
/** The whole API (admin included), for typed clients such as the admin console. */
const FULL_SPEC_FILE = new URL('../openapi/shop-api.json', import.meta.url);

const ROOT = { email: 'root@shop.test', password: 'Root-Password-2026!' };
const EDITOR = { email: 'editor@shop.test', password: 'Content-Pass-2026!' };

async function eventually<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 5_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Shop API (e2e)', () => {
  let stack: TestStack;
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    stack = await startStack();
    // Imported after env is set: ConfigModule reads process.env when the module is evaluated.
    const [
      { Test },
      { AppModule },
      { configureApp },
      { PrismaService },
      { hashPassword },
    ] = await Promise.all([
      import('@nestjs/testing'),
      import('../src/app.module.js'),
      import('../src/bootstrap.js'),
      import('../src/database/prisma.service.js'),
      import('../src/common/auth/password.js'),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();

    // The first super-admin (what `npm run admin:create` does in a real deployment).
    const prisma = app.get(PrismaService);
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'super-admin' },
    });
    await prisma.adminUser.create({
      data: {
        email: ROOT.email,
        passwordHash: await hashPassword(ROOT.password),
        roles: { create: [{ roleId: role.id }] },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
  });

  const login = async (u: { email: string; password: string }) =>
    (await http().post('/api/v1/admin/auth/login').send(u).expect(200))
      .body as { accessToken: string; refreshToken: string };

  describe('health', () => {
    it('is public and reports database, authenticated redis and storage as up', async () => {
      const res = await http().get('/api/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.info).toMatchObject({
        database: { status: 'up' },
        redis: { status: 'up', authenticated: true },
        storage: { status: 'up', bucket: 'shop-media-e2e' },
      });
    });

    it('liveness responds without dependency checks', async () => {
      await http().get('/api/v1/health/live').expect(200, { status: 'ok' });
    });

    it('the Redis server itself rejects clients without the password', async () => {
      const opts = {
        host: stack.redis.getHost(),
        port: stack.redis.getMappedPort(6379),
        lazyConnect: true,
      };
      const anon = new Redis({
        ...opts,
        maxRetriesPerRequest: 0,
        enableReadyCheck: false,
      });
      await anon.connect().catch(() => undefined);
      await expect(anon.ping()).rejects.toThrow(/NOAUTH/);
      anon.disconnect();
      const authed = new Redis({ ...opts, password: REDIS_PASSWORD });
      await authed.connect();
      expect(await authed.ping()).toBe('PONG');
      authed.disconnect();
    });
  });

  describe('admin authentication', () => {
    it('denies by default with the uniform error body and request id', async () => {
      const res = await http().get('/api/v1/admin/users').expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        error: 'Unauthorized',
        path: '/api/v1/admin/users',
      });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('rejects bad credentials with one generic message', async () => {
      const wrong = await http()
        .post('/api/v1/admin/auth/login')
        .send({ email: ROOT.email, password: 'nope' })
        .expect(401);
      const unknown = await http()
        .post('/api/v1/admin/auth/login')
        .send({ email: 'ghost@shop.test', password: 'nope' })
        .expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('logs in, reads /me, rotates the refresh token and detects reuse', async () => {
      const first = await login(ROOT);
      const me = await http()
        .get('/api/v1/admin/auth/me')
        .auth(first.accessToken, { type: 'bearer' })
        .expect(200);
      expect(me.body).toMatchObject({
        email: ROOT.email,
        roles: ['super-admin'],
        permissions: ['*'],
      });

      const second = (
        await http()
          .post('/api/v1/admin/auth/refresh')
          .send({ refreshToken: first.refreshToken })
          .expect(200)
      ).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await http()
        .get('/api/v1/admin/auth/me')
        .auth(second.accessToken, { type: 'bearer' })
        .expect(200);

      // Replaying the rotated token = theft: the whole session ends, including the newest access token.
      await http()
        .post('/api/v1/admin/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      await http()
        .post('/api/v1/admin/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(401);
      await http()
        .get('/api/v1/admin/auth/me')
        .auth(second.accessToken, { type: 'bearer' })
        .expect(401);
    });

    it('logout ends the session immediately', async () => {
      const s = await login(ROOT);
      await http()
        .post('/api/v1/admin/auth/logout')
        .auth(s.accessToken, { type: 'bearer' })
        .expect(204);
      await http()
        .get('/api/v1/admin/auth/me')
        .auth(s.accessToken, { type: 'bearer' })
        .expect(401);
      await http()
        .post('/api/v1/admin/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(401);
    });
  });

  describe('RBAC, API keys and audit', () => {
    let root: string;
    let editorId: string;
    let roleId: string;

    beforeAll(async () => {
      root = (await login(ROOT)).accessToken;
    });

    it('creates a role and a user holding it', async () => {
      const role = await http()
        .post('/api/v1/admin/roles')
        .auth(root, { type: 'bearer' })
        .send({
          code: 'content-editor',
          name: 'Content editor',
          permissions: ['cms:*', 'admin-users:read'],
        })
        .expect(201);

      roleId = role.body.id;
      const user = await http()
        .post('/api/v1/admin/users')
        .auth(root, { type: 'bearer' })
        .send({ ...EDITOR, roleIds: [roleId] })
        .expect(201);
      editorId = user.body.id;
      expect(user.body).not.toHaveProperty('passwordHash');
    });

    it('enforces permissions and blocks privilege escalation', async () => {
      const editor = (await login(EDITOR)).accessToken;
      await http()
        .get('/api/v1/admin/users')
        .auth(editor, { type: 'bearer' })
        .expect(200);
      const denied = await http()
        .get('/api/v1/admin/roles')
        .auth(editor, { type: 'bearer' })
        .expect(403);
      expect(denied.body.message).toContain('roles:read');
      await http()
        .delete(`/api/v1/admin/users/${editorId}`)
        .auth(editor, { type: 'bearer' })
        .expect(403);
    });

    it('protects the system role and the last super-admin', async () => {
      const roles = await http()
        .get('/api/v1/admin/roles')
        .auth(root, { type: 'bearer' })
        .expect(200);
      const superRole = roles.body.find(
        (r: { code: string }) => r.code === 'super-admin',
      );
      await http()
        .patch(`/api/v1/admin/roles/${superRole.id}`)
        .auth(root, { type: 'bearer' })
        .send({ name: 'Renamed' })
        .expect(403);
      await http()
        .delete(`/api/v1/admin/roles/${roleId}`)
        .auth(root, { type: 'bearer' })
        .expect(409); // still assigned
      const me = await http()
        .get('/api/v1/admin/auth/me')
        .auth(root, { type: 'bearer' })
        .expect(200);
      await http()
        .delete(`/api/v1/admin/users/${me.body.id}`)
        .auth(root, { type: 'bearer' })
        .expect(403);
    });

    it('API keys: shown once, scoped, refused on admin-only routes, revocable', async () => {
      const created = await http()
        .post('/api/v1/admin/api-keys')
        .auth(root, { type: 'bearer' })
        .send({ name: 'ERP sync', permissions: ['audit-logs:read'] })
        .expect(201);
      const key: string = created.body.key;
      expect(key).toMatch(/^shk_/);
      const listed = await http()
        .get('/api/v1/admin/api-keys')
        .auth(root, { type: 'bearer' })
        .expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(key);

      await http()
        .get('/api/v1/admin/audit-logs')
        .set('x-api-key', key)
        .expect(200);
      await http().get('/api/v1/admin/users').set('x-api-key', key).expect(403);
      await http()
        .get('/api/v1/admin/auth/me')
        .set('x-api-key', key)
        .expect(403);

      await http()
        .delete(`/api/v1/admin/api-keys/${created.body.id}`)
        .auth(root, { type: 'bearer' })
        .expect(204);
      await http()
        .get('/api/v1/admin/audit-logs')
        .set('x-api-key', key)
        .expect(401);
    });

    it('disabling a user cuts their access tokens immediately', async () => {
      const editor = (await login(EDITOR)).accessToken;
      await http()
        .patch(`/api/v1/admin/users/${editorId}`)
        .auth(root, { type: 'bearer' })
        .send({ status: 'DISABLED' })
        .expect(200);
      await http()
        .get('/api/v1/admin/users')
        .auth(editor, { type: 'bearer' })
        .expect(401);
      await http().post('/api/v1/admin/auth/login').send(EDITOR).expect(401);
    });

    it('records every committed admin change in the audit log, with the request id', async () => {
      const res = await eventually(
        () =>
          http()
            .get('/api/v1/admin/audit-logs?action=role.&limit=50')
            .auth(root, { type: 'bearer' })
            .set('x-request-id', 'e2e-audit-1'),
        (r) => r.body.data?.length > 0,
      );
      expect(res.body.data[0]).toMatchObject({
        action: 'role.created',
        entityId: roleId,
        actorType: 'admin',
        actorLabel: ROOT.email,
      });
      const users = await http()
        .get(`/api/v1/admin/audit-logs?entityId=${editorId}`)
        .auth(root, { type: 'bearer' })
        .expect(200);
      expect(users.body.data.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(['admin-user.created', 'admin-user.updated']),
      );
    });
  });

  describe('OpenAPI', () => {
    it('matches the committed storefront contract (UPDATE_CONTRACT=1 regenerates it)', async () => {
      const res = await http().get('/api/docs-json').expect(200);
      const contract = storefrontContract(res.body);
      expect(contractProblems(contract)).toEqual([]);
      const text = `${JSON.stringify(contract, null, 2)}\n`;
      if (process.env.UPDATE_CONTRACT === '1') {
        // v1 is additive-only: refuse to regenerate over breaking changes unless explicitly allowed.
        const breaking = breakingChanges(
          JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')),
          contract,
        );
        if (breaking.length && process.env.ALLOW_BREAKING !== '1')
          throw new Error(
            `Breaking storefront changes (v2 needed):\n${breaking.join('\n')}`,
          );
        writeFileSync(CONTRACT_FILE, text);
        writeFileSync(FULL_SPEC_FILE, `${JSON.stringify(res.body, null, 2)}\n`);
      }
      // A failure here means the storefront API changed: review it, then run `npm run contract:update`.
      expect(text).toBe(readFileSync(CONTRACT_FILE, 'utf8'));
    });

    it('serves the spec with the admin, API-key and customer security schemes', async () => {
      const res = await http().get('/api/docs-json').expect(200);
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(['/api/v1/health', '/api/v1/admin/auth/login']),
      );
      // Every property has a real type (no bare `object` from nullable unions).
      expect(untypedProperties(res.body)).toEqual([]);
      expect(Object.keys(res.body.components.securitySchemes).sort()).toEqual([
        'admin-jwt',
        'api-key',
        'customer',
      ]);
    });
  });
});
