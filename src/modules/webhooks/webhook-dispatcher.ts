import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import type { BaseEvent } from '../../common/events/base.event.js';
import { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { uuidFromName } from '../../common/utils/uuid.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  matches,
  WEBHOOK_EVENTS_CATALOGUE,
  webhookPayload,
} from './webhook-catalogue.js';
import { WEBHOOK_EVENTS } from './webhooks.events.js';
import { WebhooksService } from './webhooks.service.js';

/** Subscriptions are re-read at most this often (and at once after a change in this process). */
const CACHE_MS = 10_000;

/** A delivery's id: one per (webhook, event), so a redelivered event is never sent twice. */
export const deliveryId = (webhookId: string, eventId: string) =>
  uuidFromName(`webhook-delivery:${webhookId}:${eventId}`);

/**
 * Turns committed catalogue events into deliveries for the webhooks subscribed to them. Runs on
 * after-events (at least once): deliveries have deterministic ids, so repeats are no-ops.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private cache?: { at: number; hooks: { id: string; events: string[] }[] };

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly webhooks: WebhooksService,
  ) {}

  @OnEvent(WEBHOOK_EVENTS.CREATED)
  @OnEvent(WEBHOOK_EVENTS.UPDATED)
  @OnEvent(WEBHOOK_EVENTS.DELETED)
  @OnEvent(WEBHOOK_EVENTS.DISABLED)
  invalidate(): void {
    this.cache = undefined;
  }

  private async active(now = Date.now()) {
    if (!this.cache || now - this.cache.at > CACHE_MS)
      this.cache = {
        at: now,
        hooks: await this.prisma.webhook.findMany({
          where: { isActive: true },
          select: { id: true, events: true },
        }),
      };
    return this.cache.hooks;
  }

  @OnEvent('**', { async: true, promisify: true })
  async onEvent(event: BaseEvent): Promise<void> {
    if (!event?.eventId || !(event.name in WEBHOOK_EVENTS_CATALOGUE)) return;
    const hooks = (await this.active()).filter((h) =>
      matches(h.events, event.name),
    );
    if (!hooks.length) return;
    const payload = webhookPayload(event) as Prisma.InputJsonValue;
    const rows = hooks.map((h) => ({
      id: deliveryId(h.id, event.eventId!),
      webhookId: h.id,
      eventId: event.eventId!,
      eventName: event.name,
      payload,
    }));
    const { count } = await this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.DELIVERY_BEFORE_WRITE,
        'dispatch',
        event.eventId,
        SYSTEM_ACTOR,
        { event: event.name },
      ),
      work: (tx) =>
        tx.webhookDelivery.createMany({ data: rows, skipDuplicates: true }),
    });
    for (const r of rows) await this.webhooks.enqueue(r.id);
    if (count)
      this.logger.debug(`${event.name}: ${count} webhook delivery(ies) queued`);
  }
}
