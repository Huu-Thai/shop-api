import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import type { PrismaService } from '../database/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { HealthIndicators } from './health.indicators.js';

function setup(
  overrides: {
    db?: () => Promise<unknown>;
    ping?: () => Promise<string>;
    storage?: () => Promise<void>;
  } = {},
) {
  const prisma = {
    $queryRaw: vi.fn(overrides.db ?? (async () => [{ 1: 1 }])),
  } as unknown as PrismaService;
  const redis = {
    status: 'ready',
    connect: vi.fn(),
    ping: vi.fn(overrides.ping ?? (async () => 'PONG')),
  } as unknown as Redis;
  const storage = {
    bucket: 'b',
    ping: vi.fn(overrides.storage ?? (async () => undefined)),
  } as unknown as StorageService;
  return new HealthIndicators(
    new HealthIndicatorService(),
    prisma,
    redis,
    storage,
  );
}

describe('HealthIndicators', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports up when dependencies respond', async () => {
    const h = setup();
    expect((await h.database()).database.status).toBe('up');
    expect((await h.redisPing()).redis).toMatchObject({
      status: 'up',
      authenticated: true,
    });
    expect((await h.objectStorage()).storage).toMatchObject({
      status: 'up',
      bucket: 'b',
    });
  });

  it('reports down with the error message', async () => {
    const h = setup({
      db: async () => Promise.reject(new Error('db gone')),
      ping: async () =>
        Promise.reject(new Error('NOAUTH Authentication required.')),
      storage: async () => Promise.reject(new Error('NoSuchBucket')),
    });
    expect((await h.database()).database).toMatchObject({
      status: 'down',
      message: 'db gone',
    });
    expect((await h.redisPing()).redis).toMatchObject({
      status: 'down',
      message: 'NOAUTH Authentication required.',
    });
    expect((await h.objectStorage()).storage).toMatchObject({
      status: 'down',
      message: 'NoSuchBucket',
    });
  });
});
