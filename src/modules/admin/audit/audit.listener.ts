import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isAudited } from '../../../common/events/audited.event.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';

/**
 * Records every AuditedEvent (any module) in `audit_logs`. Runs on after-events, so only
 * committed changes are logged; outbox redelivery keeps request id / IP captured in the event.
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('**', { async: true, promisify: true })
  async record(event: unknown): Promise<void> {
    if (!isAudited(event)) return;
    try {
      // Once per event: a redelivered event (another listener failed) is skipped by event id.
      await this.prisma.auditLog.createMany({
        skipDuplicates: true,
        data: {
          actorType: event.actor.type,
          actorId: event.actor.id,
          actorLabel: event.actor.label.slice(0, 255),
          action: event.audit.action,
          entityType: event.audit.entityType,
          entityId: event.audit.entityId,
          changes: (event.audit.changes ?? undefined) as
            Prisma.InputJsonValue | undefined,
          requestId: event.requestId,
          ip: event.ip,
          eventId: event.eventId,
          createdAt: new Date(event.occurredAt),
        },
      });
    } catch (e) {
      this.logger.error(
        `Could not write audit log for ${event.audit.action}: ${(e as Error).message}`,
      );
    }
  }
}
