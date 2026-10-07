import type { ActorRef } from '../auth/principal.js';
import { AuditedEvent, type AuditInfo } from './audited.event.js';
import { BaseEvent } from './base.event.js';

/**
 * Generic before-event for catalog-style modules: `<entity>.before-write`. Carries the intended
 * change so listeners in other modules can veto it (e.g. url-rewrites rejects a colliding slug).
 * Listeners must not write.
 */
export class BeforeWriteEvent<I = unknown> extends BaseEvent {
  constructor(
    readonly name: string,
    readonly action: string,
    readonly entityId: string | null,
    readonly actor: ActorRef,
    readonly input?: I,
  ) {
    super();
  }
}

/**
 * Generic audited after-event (`product.updated`, `store.created`…). `data` holds what listeners
 * need (ids, slugs, affected websites) — plain JSON, since the outbox may redeliver it as such.
 */
export class EntityEvent<
  D extends object = Record<string, unknown>,
> extends AuditedEvent {
  readonly audit: AuditInfo;
  constructor(
    readonly name: string,
    actor: ActorRef,
    readonly entityType: string,
    readonly entityId: string,
    changes?: Record<string, unknown>,
    readonly data: D = {} as D,
  ) {
    super(actor);
    this.audit = { action: name, entityType, entityId, changes };
  }
}

/** Non-audited after-event for derived data (projections such as URL rewrites or renditions). */
export class ProjectionEvent<
  D extends object = Record<string, unknown>,
> extends BaseEvent {
  constructor(
    readonly name: string,
    readonly data: D,
  ) {
    super();
  }
}

/** Standard event names for an entity: `<entity>.before-write|created|updated|deleted`. */
export function entityEvents<E extends string>(entity: E) {
  return {
    BEFORE_WRITE: `${entity}.before-write`,
    CREATED: `${entity}.created`,
    UPDATED: `${entity}.updated`,
    DELETED: `${entity}.deleted`,
  } as const;
}
