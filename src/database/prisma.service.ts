import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AppConfig } from '../config/configuration.js';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';

export type PrismaTransaction = Prisma.TransactionClient;

/**
 * node-postgres pool settings: bounded size, a bounded wait for a connection, and sessions pinned
 * to UTC. The Prisma pg adapter sends DateTime parameters as UTC wall-clock text without an
 * offset, which Postgres reads in the session time zone — on a server whose default zone isn't
 * UTC every Prisma-written timestamp would shift by that offset (and disagree with `now()`).
 */
export const poolConfig = (db: AppConfig['database']) => ({
  connectionString: db.url,
  max: db.poolMax,
  connectionTimeoutMillis: db.poolTimeoutMs,
  idleTimeoutMillis: 30_000,
  options: '-c TimeZone=UTC',
});

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    super({
      adapter: new PrismaPg(
        poolConfig(config.get('database', { infer: true })),
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  /**
   * Disconnect last: Nest runs every onModuleDestroy before any onApplicationShutdown, so
   * after-commit deliveries drained in OutboxDispatcher.onModuleDestroy still have the database.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
