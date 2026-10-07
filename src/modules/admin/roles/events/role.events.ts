import { BaseEvent } from '../../../../common/events/base.event.js';
import {
  AuditedEvent,
  type AuditInfo,
} from '../../../../common/events/audited.event.js';
import type { ActorRef } from '../../../../common/auth/principal.js';

export const ROLE_EVENTS = {
  BEFORE_WRITE: 'role.before-write',
  CREATED: 'role.created',
  UPDATED: 'role.updated',
  DELETED: 'role.deleted',
} as const;

export class RoleBeforeWriteEvent extends BaseEvent {
  readonly name = ROLE_EVENTS.BEFORE_WRITE;
  constructor(
    readonly action: 'create' | 'update' | 'delete',
    readonly roleId: string | null,
    readonly actor: ActorRef,
  ) {
    super();
  }
}

export class RoleCreatedEvent extends AuditedEvent {
  readonly name = ROLE_EVENTS.CREATED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly roleId: string,
    code: string,
    permissions: string[],
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'role',
      entityId: roleId,
      changes: { code, permissions },
    };
  }
}

export class RoleUpdatedEvent extends AuditedEvent {
  readonly name = ROLE_EVENTS.UPDATED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly roleId: string,
    changes: Record<string, unknown>,
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'role',
      entityId: roleId,
      changes,
    };
  }
}

export class RoleDeletedEvent extends AuditedEvent {
  readonly name = ROLE_EVENTS.DELETED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly roleId: string,
    code: string,
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'role',
      entityId: roleId,
      changes: { code },
    };
  }
}
