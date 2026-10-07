import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';

export const ROOT = {
  email: 'root@shop.test',
  password: 'Root-Password-2026!',
};

/** Boots the HTTP app exactly like main.ts (call after startStack set the environment). */
export async function startApp(): Promise<INestApplication> {
  const [{ Test }, { AppModule }, { configureApp }] = await Promise.all([
    import('@nestjs/testing'),
    import('../../src/app.module.js'),
    import('../../src/bootstrap.js'),
  ]);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({
    bufferLogs: true,
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return app;
}

/** A worker process context running the given queues (empty = all). */
export async function startWorker(
  queues: string[] = [],
): Promise<INestApplicationContext> {
  const [{ NestFactory }, { WorkerModule }] = await Promise.all([
    import('@nestjs/core'),
    import('../../src/worker.module.js'),
  ]);
  const ctx = await NestFactory.createApplicationContext(
    WorkerModule.forQueues(queues),
    { logger: ['error'] },
  );
  await ctx.init();
  return ctx;
}

/** Creates the first super-admin (what `npm run admin:create` does) and returns an access token. */
export async function rootToken(app: INestApplication): Promise<string> {
  const [{ PrismaService }, { hashPassword }] = await Promise.all([
    import('../../src/database/prisma.service.js'),
    import('../../src/common/auth/password.js'),
  ]);
  const prisma = app.get(PrismaService);
  const role = await prisma.role.findUniqueOrThrow({
    where: { code: 'super-admin' },
  });
  await prisma.adminUser.upsert({
    where: { email: ROOT.email },
    create: {
      email: ROOT.email,
      passwordHash: await hashPassword(ROOT.password),
      roles: { create: [{ roleId: role.id }] },
    },
    update: {},
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/admin/auth/login')
    .send(ROOT)
    .expect(200);
  return res.body.accessToken as string;
}

/** Polls until `ok` holds (after-commit listeners and workers are asynchronous). */
export async function eventually<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
