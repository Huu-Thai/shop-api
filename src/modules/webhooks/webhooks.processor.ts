import { webhookDeliveries } from '../../metrics/metrics.js';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { withJobContext } from '../../common/utils/job-context.js';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS, type WebhookDeliverJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { signature } from './webhook-catalogue.js';
import { type SendResult, WebhookSender } from './webhook-sender.js';
import { WEBHOOK_EVENTS } from './webhooks.events.js';
import { RETRY_BASE_MS } from './webhooks.service.js';

/** Thrown to let the queue retry a failed delivery with backoff. */
export class DeliveryFailedError extends Error {}

/**
 * Delivers webhooks: signs the stored payload, POSTs it, records every attempt. A failure is
 * retried with exponential backoff; after the last attempt the delivery is failed and counts
 * towards switching the webhook off (WEBHOOK_DISABLE_AFTER in a row, or at once on 410 Gone).
 */
@Processor(QUEUES.NOTIFICATIONS, { concurrency: 10 })
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly secrets: SecretsService,
    private readonly sender: WebhookSender,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super();
  }

  process(job: Job) {
    return withJobContext(job, async () => {
      if (job.name === JOBS.WEBHOOK_DELIVER)
        return this.deliver(
          (job.data as WebhookDeliverJob).deliveryId,
          job.attemptsMade + 1,
          job.opts.attempts ?? 1,
        );
      if (job.name === JOBS.WEBHOOKS_PURGE)
        return { purged: await this.purge() };
      return { skipped: `unknown job ${job.name}` };
    });
  }

  private before(action: string, id: string) {
    return new BeforeWriteEvent(
      WEBHOOK_EVENTS.DELIVERY_BEFORE_WRITE,
      action,
      id,
      SYSTEM_ACTOR,
    );
  }

  async deliver(id: string, attempt: number, maxAttempts: number) {
    const d = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        eventId: true,
        eventName: true,
        payload: true,
        status: true,
        webhook: {
          select: { id: true, url: true, secret: true, isActive: true },
        },
      },
    });
    if (!d) return { skipped: 'delivery removed' };
    if (d.status === 'SUCCEEDED') return { skipped: 'already delivered' };
    if (!d.webhook.isActive) {
      await this.record(d.id, d.webhook.id, null, {
        status: 'FAILED',
        error: 'The webhook is switched off',
      });
      return { skipped: 'webhook switched off' };
    }
    const body = JSON.stringify(d.payload);
    const { secret } = this.secrets.open<{ secret: string }>(d.webhook.secret);
    const res = await this.sender.send(d.webhook.url, body, {
      'x-shop-event': d.eventName,
      'x-shop-event-id': d.eventId,
      'x-shop-delivery': d.id,
      'x-shop-signature': signature(secret, body, Date.now()),
    });
    if (res.ok) {
      webhookDeliveries.inc({ outcome: 'succeeded' });
      await this.record(d.id, d.webhook.id, res, { status: 'SUCCEEDED' });
      return { status: res.status, durationMs: res.durationMs };
    }
    const gone = res.status === 410;
    const final = gone || attempt >= maxAttempts;
    webhookDeliveries.inc({ outcome: final ? 'failed' : 'retry' });
    await this.record(d.id, d.webhook.id, res, {
      status: final ? 'FAILED' : 'PENDING',
      nextAttemptAt: final
        ? null
        : new Date(Date.now() + RETRY_BASE_MS * 2 ** (attempt - 1)),
      failedFinally: final,
      gone,
    });
    if (final) return { failed: res.status ?? res.error };
    throw new DeliveryFailedError(
      `${d.webhook.url} answered ${res.status ?? res.error} (attempt ${attempt}/${maxAttempts})`,
    );
  }

  private async record(
    id: string,
    webhookId: string,
    res: SendResult | null,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
      error?: string;
      nextAttemptAt?: Date | null;
      failedFinally?: boolean;
      gone?: boolean;
    },
  ): Promise<void> {
    const { disableAfter } = this.config.get('webhooks', { infer: true });
    await this.bus.write({
      before: this.before('attempt', id),
      work: async (tx, after) => {
        await tx.webhookDelivery.update({
          where: { id },
          data: {
            status: outcome.status,
            ...(res
              ? {
                  attempts: { increment: 1 },
                  responseStatus: res.status,
                  responseBody: res.body,
                  error: res.error,
                  durationMs: res.durationMs,
                }
              : { error: outcome.error }),
            nextAttemptAt: outcome.nextAttemptAt ?? null,
            ...(outcome.status === 'SUCCEEDED'
              ? { deliveredAt: new Date() }
              : {}),
          },
        });
        if (outcome.status === 'SUCCEEDED') {
          await tx.webhook.updateMany({
            where: { id: webhookId, consecutiveFailures: { gt: 0 } },
            data: { consecutiveFailures: 0 },
          });
          return;
        }
        if (!outcome.failedFinally) return;
        const w = await tx.webhook.update({
          where: { id: webhookId },
          data: { consecutiveFailures: { increment: 1 } },
          select: { consecutiveFailures: true, isActive: true },
        });
        const reason = outcome.gone
          ? 'The receiver answered 410 Gone'
          : w.consecutiveFailures >= disableAfter
            ? `${w.consecutiveFailures} deliveries failed in a row`
            : null;
        if (reason && w.isActive) {
          await tx.webhook.update({
            where: { id: webhookId },
            data: { isActive: false, disabledReason: reason },
          });
          after.add(
            new EntityEvent(
              WEBHOOK_EVENTS.DISABLED,
              SYSTEM_ACTOR,
              'webhook',
              webhookId,
              { reason },
              { webhookId },
            ),
          );
          this.logger.warn(`Webhook ${webhookId} switched off: ${reason}`);
        }
      },
    });
  }

  /** Deliveries older than WEBHOOK_DELIVERY_RETENTION_DAYS, in batches. */
  async purge(now = new Date()): Promise<number> {
    const days = this.config.get('webhooks', { infer: true }).retentionDays;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM webhook_deliveries WHERE id IN (
          SELECT id FROM webhook_deliveries WHERE created_at < ${cutoff} AND status <> 'PENDING' LIMIT 5000)`;
      total += n;
      if (n < 5000) break;
    }
    return total;
  }
}

@Injectable()
export class WebhooksScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'purge-webhook-deliveries',
      { pattern: '0 5 * * *', tz: 'UTC' },
      {
        name: JOBS.WEBHOOKS_PURGE,
        data: {},
        opts: { attempts: 2, removeOnComplete: 30, removeOnFail: 30 },
      },
    );
  }
}
