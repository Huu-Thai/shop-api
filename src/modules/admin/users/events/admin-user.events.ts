import { BaseEvent } from '../../../../common/events/base.event.js';
import {
  AuditedEvent,
  type AuditInfo,
} from '../../../../common/events/audited.event.js';
import type { ActorRef } from '../../../../common/auth/principal.js';

export const ADMIN_USER_EVENTS = {
  BEFORE_WRITE: 'admin-user.before-write',
  CREATED: 'admin-user.created',
  UPDATED: 'admin-user.updated',
  PASSWORD_CHANGED: 'admin-user.password-changed',
  DELETED: 'admin-user.deleted',
} as const;

export class AdminUserBeforeWriteEvent extends BaseEvent {
  readonly name = ADMIN_USER_EVENTS.BEFORE_WRITE;
  constructor(
    readonly action: 'create' | 'update' | 'password' | 'delete',
    readonly adminUserId: string | null,
    readonly actor: ActorRef,
  ) {
    super();
  }
}

export class AdminUserCreatedEvent extends AuditedEvent {
  readonly name = ADMIN_USER_EVENTS.CREATED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly adminUserId: string,
    email: string,
    roleCodes: string[],
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { email, roles: roleCodes },
    };
  }
}

export class AdminUserUpdatedEvent extends AuditedEvent {
  readonly name = ADMIN_USER_EVENTS.UPDATED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly adminUserId: string,
    changes: Record<string, unknown>,
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes,
    };
  }
}

export class AdminUserPasswordChangedEvent extends AuditedEvent {
  readonly name = ADMIN_USER_EVENTS.PASSWORD_CHANGED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly adminUserId: string,
    by: 'self' | 'admin',
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { by },
    };
  }
}

export class AdminUserDeletedEvent extends AuditedEvent {
  readonly name = ADMIN_USER_EVENTS.DELETED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly adminUserId: string,
    email: string,
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { email },
    };
  }
}
