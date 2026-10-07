import type { Request } from 'express';

/** Who is calling: an admin (JWT) or an integration (API key). */
export interface Principal {
  type: 'admin' | 'api-key';
  id: string;
  /** e-mail for admins, key name for API keys — recorded in the audit log. */
  label: string;
  permissions: string[];
  /** Admin refresh-token family of this session (for logout). */
  sessionId?: string;
}

/** Actor recorded on events and audit rows (also `system` for jobs and CLIs). */
export interface ActorRef {
  type: 'admin' | 'api-key' | 'system' | 'customer';
  id: string | null;
  label: string;
}

export const SYSTEM_ACTOR: ActorRef = {
  type: 'system',
  id: null,
  label: 'system',
};

export function actorOf(p: Principal | undefined): ActorRef {
  return p ? { type: p.type, id: p.id, label: p.label } : SYSTEM_ACTOR;
}

export type AuthenticatedRequest = Request & { principal?: Principal };
