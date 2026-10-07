import { BaseEvent } from '../../../../common/events/base.event.js';
import {
  AuditedEvent,
  type AuditInfo,
} from '../../../../common/events/audited.event.js';
import type { ActorRef } from '../../../../common/auth/principal.js';

export const API_KEY_EVENTS = {
  BEFORE_WRITE: 'api-key.before-write',
  CREATED: 'api-key.created',
  REVOKED: 'api-key.revoked',
} as const;

export class ApiKeyBeforeWriteEvent extends BaseEvent {
  readonly name = API_KEY_EVENTS.BEFORE_WRITE;
  constructor(
    readonly action: 'create' | 'revoke',
    readonly apiKeyId: string | null,
    readonly actor: ActorRef,
  ) {
    super();
  }
}

export class ApiKeyCreatedEvent extends AuditedEvent {
  readonly name = API_KEY_EVENTS.CREATED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly apiKeyId: string,
    keyName: string,
    prefix: string,
    permissions: string[],
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'api_key',
      entityId: apiKeyId,
      changes: { name: keyName, prefix, permissions },
    };
  }
}

export class ApiKeyRevokedEvent extends AuditedEvent {
  readonly name = API_KEY_EVENTS.REVOKED;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly apiKeyId: string,
    keyName: string,
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'api_key',
      entityId: apiKeyId,
      changes: { name: keyName },
    };
  }
}
