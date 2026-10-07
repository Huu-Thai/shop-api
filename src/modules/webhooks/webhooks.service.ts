import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../config/configuration.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS, type WebhookDeliverJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import type {
  CreateWebhookDto,
  ListDeliveriesQueryDto,
  UpdateWebhookDto,
  WebhookDeliveryDto,
  WebhookDto,
  WebhookEventTypeDto,
  WebhookWithSecretDto,
} from './dto/webhooks.dto.js';
import {
  PING_EVENT,
  unknownPatterns,
  WEBHOOK_EVENTS_CATALOGUE,
} from './webhook-catalogue.js';
import { isBlockedAddress } from './webhook-sender.js';
import { WEBHOOK_EVENTS } from './webhooks.events.js';

const SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  isActive: true,
  consecutiveFailures: true,
  disabledReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WebhookSelect;

export const DELIVERY_SELECT = {
  id: true,
  webhookId: true,
  eventId: true,
  eventName: true,
  payload: true,
  status: true,
  attempts: true,
  responseStatus: true,
  responseBody: true,
  error: true,
  durationMs: true,
  nextAttemptAt: true,
  deliveredAt: true,
  createdAt: true,
} as const satisfies Prisma.WebhookDeliverySelect;

/** Retries double from this delay (1 min, 2, 4 … with WEBHOOK_MAX_ATTEMPTS = 10: ≈ 8.5 h in all). */
export const RETRY_BASE_MS = 60_000;

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** Outgoing webhooks (PLAN.md §3.2): subscriptions, their signing secrets and deliveries. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  events(): WebhookEventTypeDto[] {
    return Object.entries(WEBHOOK_EVENTS_CATALOGUE).map(
      ([type, description]) => ({ type, description }),
    );
  }

  /** https in production, no credentials in the URL, never a private address literal. */
  private assertTarget(url: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new BadRequestException('url is not a valid URL');
    }
    const production = this.config.get('env', { infer: true }) === 'production';
    if (u.protocol !== 'https:' && (production || u.protocol !== 'http:'))
      throw new BadRequestException(
        production ? 'url must be https' : 'url must be http(s)',
      );
    if (u.username || u.password)
      throw new BadRequestException(
        'Put no credentials in the URL; verify the signature instead',
      );
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const allowPrivate = this.config.get('webhooks', {
      infer: true,
    }).allowPrivateTargets;
    if (
      !allowPrivate &&
      (host === 'localhost' ||
        host.endsWith('.localhost') ||
        (isIP(host) && isBlockedAddress(host)))
    )
      throw new BadRequestException(
        'url points to a private address; webhooks can only reach public hosts',
      );
  }

  private assertEvents(events: string[]): void {
    const unknown = unknownPatterns(events);
    if (unknown.length)
      throw new BadRequestException(
        `Unknown event(s): ${unknown.join(', ')} (see GET /admin/webhooks/events)`,
      );
  }

  async list(): Promise<WebhookDto[]> {
    return this.prisma.webhook.findMany({
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(id: string): Promise<WebhookDto> {
    const w = await this.prisma.webhook.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!w) throw new NotFoundException(`Webhook ${id} not found`);
    return w;
  }

  async create(
    dto: CreateWebhookDto,
    principal: Principal,
  ): Promise<WebhookWithSecretDto> {
    this.assertTarget(dto.url);
    this.assertEvents(dto.events);
    const secret = newSecret();
    const sealed = this.secrets.seal({ secret });
    return this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(principal),
        { url: dto.url, events: dto.events },
      ),
      work: async (tx, after) => {
        const w = await tx.webhook.create({
          data: {
            name: dto.name,
            url: dto.url,
            events: [...new Set(dto.events)],
            secret: sealed,
            isActive: dto.isActive ?? true,
            createdById: principal.type === 'admin' ? principal.id : null,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            WEBHOOK_EVENTS.CREATED,
            actorOf(principal),
            'webhook',
            w.id,
            { name: w.name, url: w.url, events: w.events },
            { webhookId: w.id },
          ),
        );
        return { ...w, secret };
      },
    });
  }

  async update(
    id: string,
    dto: UpdateWebhookDto,
    principal: Principal,
  ): Promise<WebhookDto> {
    if (dto.url) this.assertTarget(dto.url);
    if (dto.events) this.assertEvents(dto.events);
    const before = await this.get(id);
    const reenable = dto.isActive === true && !before.isActive;
    return this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(principal),
        dto,
      ),
      work: async (tx, after) => {
        const w = await tx.webhook.update({
          where: { id },
          data: {
            name: dto.name,
            url: dto.url,
            events: dto.events ? [...new Set(dto.events)] : undefined,
            isActive: dto.isActive,
            ...(reenable
              ? { consecutiveFailures: 0, disabledReason: null }
              : {}),
          },
          select: SELECT,
        });
        const changes = diff(
          before as unknown as Record<string, unknown>,
          w as unknown as Record<string, unknown>,
          ['name', 'url', 'events', 'isActive'],
        );
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              WEBHOOK_EVENTS.UPDATED,
              actorOf(principal),
              'webhook',
              id,
              changes,
              { webhookId: id },
            ),
          );
        return w;
      },
    });
  }

  async rotateSecret(
    id: string,
    principal: Principal,
  ): Promise<WebhookWithSecretDto> {
    await this.get(id);
    const secret = newSecret();
    const sealed = this.secrets.seal({ secret });
    return this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.BEFORE_WRITE,
        'rotate-secret',
        id,
        actorOf(principal),
      ),
      work: async (tx, after) => {
        const w = await tx.webhook.update({
          where: { id },
          data: { secret: sealed },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            WEBHOOK_EVENTS.SECRET_ROTATED,
            actorOf(principal),
            'webhook',
            id,
            {},
            { webhookId: id },
          ),
        );
        return { ...w, secret };
      },
    });
  }

  async remove(id: string, principal: Principal): Promise<void> {
    const w = await this.get(id);
    await this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(principal),
      ),
      work: async (tx, after) => {
        await tx.webhook.delete({ where: { id } });
        after.add(
          new EntityEvent(
            WEBHOOK_EVENTS.DELETED,
            actorOf(principal),
            'webhook',
            id,
            { name: w.name, url: w.url },
            { webhookId: id },
          ),
        );
      },
    });
  }

  /** Sends a `webhook.ping` delivery now (to check the receiver and its signature check). */
  async test(id: string, principal: Principal): Promise<WebhookDeliveryDto> {
    await this.get(id);
    const eventId = randomUUID();
    const d = await this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.DELIVERY_BEFORE_WRITE,
        'test',
        id,
        actorOf(principal),
      ),
      work: (tx) =>
        tx.webhookDelivery.create({
          data: {
            webhookId: id,
            eventId,
            eventName: PING_EVENT,
            payload: {
              id: eventId,
              type: PING_EVENT,
              createdAt: new Date().toISOString(),
              data: { webhookId: id },
            },
          },
          select: DELIVERY_SELECT,
        }),
    });
    await this.enqueue(d.id);
    return d;
  }

  async deliveries(
    webhookId: string,
    q: ListDeliveriesQueryDto,
  ): Promise<Paginated<WebhookDeliveryDto>> {
    await this.get(webhookId);
    const where = { webhookId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        select: DELIVERY_SELECT,
        orderBy: [{ createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  /** Sends a delivery again (a new round of retries), e.g. after the receiver was fixed. */
  async redeliver(
    deliveryId: string,
    principal: Principal,
  ): Promise<WebhookDeliveryDto> {
    const d = await this.bus.write({
      before: new BeforeWriteEvent(
        WEBHOOK_EVENTS.DELIVERY_BEFORE_WRITE,
        'redeliver',
        deliveryId,
        actorOf(principal),
      ),
      work: async (tx) => {
        const { count } = await tx.webhookDelivery.updateMany({
          where: { id: deliveryId },
          data: { status: 'PENDING', nextAttemptAt: new Date() },
        });
        if (!count)
          throw new NotFoundException(`Delivery ${deliveryId} not found`);
        return tx.webhookDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          select: DELIVERY_SELECT,
        });
      },
    });
    // A new message (BullMQ ids can't contain ":"), with a fresh round of retries.
    await this.enqueue(d.id, `${d.id}-r${Date.now()}`);
    return d;
  }

  /** One message per delivery (its id), retried with exponential backoff. */
  async enqueue(deliveryId: string, jobId = deliveryId): Promise<void> {
    await this.queue.add(
      JOBS.WEBHOOK_DELIVER,
      { deliveryId } satisfies WebhookDeliverJob,
      {
        jobId,
        attempts: this.config.get('webhooks', { infer: true }).maxAttempts,
        backoff: { type: 'exponential', delay: RETRY_BASE_MS },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    );
  }
}
