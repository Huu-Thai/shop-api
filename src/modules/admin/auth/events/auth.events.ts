import { BaseEvent } from '../../../../common/events/base.event.js';
import {
  AuditedEvent,
  type AuditInfo,
} from '../../../../common/events/audited.event.js';
import type { ActorRef } from '../../../../common/auth/principal.js';

export const AUTH_EVENTS = {
  BEFORE_SESSION_WRITE: 'auth.before-session-write',
  LOGGED_IN: 'auth.logged-in',
  LOGIN_FAILED: 'auth.login-failed',
  ACCOUNT_LOCKED: 'auth.account-locked',
  REFRESHED: 'auth.refreshed',
  LOGGED_OUT: 'auth.logged-out',
  TOKEN_REUSE_DETECTED: 'auth.token-reuse-detected',
} as const;

export class AuthBeforeSessionWriteEvent extends BaseEvent {
  readonly name = AUTH_EVENTS.BEFORE_SESSION_WRITE;
  constructor(
    readonly action:
      'login' | 'login-failed' | 'refresh' | 'logout' | 'revoke-family',
    readonly adminUserId: string | null,
  ) {
    super();
  }
}

const userActor = (id: string, email: string): ActorRef => ({
  type: 'admin',
  id,
  label: email,
});

export class LoggedInEvent extends AuditedEvent {
  readonly name = AUTH_EVENTS.LOGGED_IN;
  readonly audit: AuditInfo;
  constructor(
    readonly adminUserId: string,
    email: string,
    readonly sessionId: string,
  ) {
    super(userActor(adminUserId, email));
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
    };
  }
}

/** Failed attempt on an existing account (unknown e-mails are not recorded — no enumeration oracle). */
export class LoginFailedEvent extends AuditedEvent {
  readonly name = AUTH_EVENTS.LOGIN_FAILED;
  readonly audit: AuditInfo;
  constructor(
    readonly adminUserId: string,
    email: string,
    failedLogins: number,
  ) {
    super(userActor(adminUserId, email));
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { failedLogins },
    };
  }
}

export class AccountLockedEvent extends AuditedEvent {
  readonly name = AUTH_EVENTS.ACCOUNT_LOCKED;
  readonly audit: AuditInfo;
  constructor(
    readonly adminUserId: string,
    email: string,
    lockedUntil: Date,
  ) {
    super(userActor(adminUserId, email));
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { lockedUntil: lockedUntil.toISOString() },
    };
  }
}

export class LoggedOutEvent extends AuditedEvent {
  readonly name = AUTH_EVENTS.LOGGED_OUT;
  readonly audit: AuditInfo;
  constructor(
    actor: ActorRef,
    readonly adminUserId: string,
    readonly sessionId: string,
    scope: 'session' | 'all',
  ) {
    super(actor);
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: { scope },
    };
  }
}

export class TokenReuseDetectedEvent extends AuditedEvent {
  readonly name = AUTH_EVENTS.TOKEN_REUSE_DETECTED;
  readonly audit: AuditInfo;
  constructor(
    readonly adminUserId: string,
    email: string,
    readonly sessionId: string,
  ) {
    super(userActor(adminUserId, email));
    this.audit = {
      action: this.name,
      entityType: 'admin_user',
      entityId: adminUserId,
      changes: {
        note: 'A rotated refresh token was replayed; the whole session was revoked',
      },
    };
  }
}
