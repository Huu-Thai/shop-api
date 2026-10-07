import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import { StorageService } from '../storage/storage.service.js';

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; responseTimeMs: number }> {
  const started = Date.now();
  const result = await fn();
  return { result, responseTimeMs: Date.now() - started };
}

/** Dependency checks for /health. Each returns up/down without throwing secrets into the body. */
@Injectable()
export class HealthIndicators {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
  ) {}

  async database() {
    const check = this.indicator.check('database');
    try {
      const { responseTimeMs } = await timed(
        () => this.prisma.$queryRaw`SELECT 1`,
      );
      return check.up({ responseTimeMs });
    } catch (e) {
      return check.down({ message: errMessage(e) });
    }
  }

  async redisPing() {
    const check = this.indicator.check('redis');
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const { result, responseTimeMs } = await timed(() => this.redis.ping());
      return result === 'PONG'
        ? check.up({ responseTimeMs, authenticated: true })
        : check.down({ message: result });
    } catch (e) {
      return check.down({ message: errMessage(e) });
    }
  }

  async objectStorage() {
    const check = this.indicator.check('storage');
    try {
      const { responseTimeMs } = await timed(() => this.storage.ping());
      return check.up({ bucket: this.storage.bucket, responseTimeMs });
    } catch (e) {
      return check.down({
        bucket: this.storage.bucket,
        message: errMessage(e),
      });
    }
  }
}
