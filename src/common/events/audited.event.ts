import { requestContext } from '../../logger/request-context.js';
import type { ActorRef } from '../auth/principal.js';
import { BaseEvent } from './base.event.js';

export interface AuditInfo {
  /** e.g. `admin-user.created`, `role.permissions-changed`, `auth.login-failed` */
  action: string;
  entityType: string;
  entityId: string | null;
  /** Field changes `{ field: { from, to } }` or a summary; never secrets. */
  changes?: Record<string, unknown>;
}

/**
 * After-event that also lands in `audit_logs` (AuditListener). Captures the request id and
 * client IP at construction (inside the request), so outbox redelivery keeps them.
 */
export abstract class AuditedEvent extends BaseEvent {
  readonly requestId = requestContext.get()?.requestId ?? null;
  readonly ip = requestContext.get()?.ip ?? null;
  abstract readonly audit: AuditInfo;

  constructor(readonly actor: ActorRef) {
    super();
  }
}

export function isAudited(e: unknown): e is AuditedEvent {
  return !!e && typeof e === 'object' && 'audit' in e && 'actor' in e;
}

/** `{ field: { from, to } }` for the fields that actually changed. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (JSON.stringify(before[f]) !== JSON.stringify(after[f]))
      out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}
