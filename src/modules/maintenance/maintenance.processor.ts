import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { AppConfig } from '../../config/configuration.js';
import { withJobContext } from '../../common/utils/job-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';

/** Refresh tokens are kept 7 days past expiry/revocation (reuse detection), then deleted. */
export const REFRESH_TOKEN_GRACE_DAYS = 7;

@Processor(QUEUES.MAINTENANCE, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.PURGE_REFRESH_TOKENS)
        return { purged: await this.purgeRefreshTokens() };
      if (job.name === JOBS.AUDIT_PURGE)
        return { purged: await this.purgeAuditLogs() };
      return { skipped: `unknown job ${job.name}` };
    });
  }

  /** Expired or revoked for longer than the grace period. Batched to keep transactions short. */
  async purgeRefreshTokens(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - REFRESH_TOKEN_GRACE_DAYS * 86_400_000,
    );
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM refresh_tokens WHERE id IN (
          SELECT id FROM refresh_tokens
           WHERE expires_at < ${cutoff} OR revoked_at < ${cutoff}
           LIMIT 5000)`;
      total += n;
      if (n < 5000) break;
    }
    if (total) this.logger.log(`Purged ${total} stale refresh tokens`);
    return total;
  }

  /** Audit rows past AUDIT_RETENTION_DAYS (0 keeps everything), in batches. */
  async purgeAuditLogs(now = new Date()): Promise<number> {
    const days = this.config.get('audit', { infer: true }).retentionDays;
    if (!days) return 0;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM audit_logs WHERE id IN (
          SELECT id FROM audit_logs WHERE created_at < ${cutoff} LIMIT 5000)`;
      total += n;
      if (n < 5000) break;
    }
    if (total)
      this.logger.log(`Purged ${total} audit log rows older than ${days} days`);
    return total;
  }
}

@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUEUES.MAINTENANCE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'purge-refresh-tokens-daily',
      { pattern: '15 3 * * *', tz: 'UTC' },
      {
        name: JOBS.PURGE_REFRESH_TOKENS,
        data: {},
        opts: { attempts: 2, removeOnComplete: { count: 30 } },
      },
    );
    await this.queue.upsertJobScheduler(
      'purge-audit-logs-daily',
      { pattern: '45 2 * * *', tz: 'UTC' },
      {
        name: JOBS.AUDIT_PURGE,
        data: {},
        opts: { attempts: 2, removeOnComplete: { count: 30 } },
      },
    );
  }
}
