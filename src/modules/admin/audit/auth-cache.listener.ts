import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrincipalResolver } from '../../../common/auth/principal.resolver.js';
import { API_KEY_EVENTS } from '../api-keys/events/api-key.events.js';
import { ROLE_EVENTS } from '../roles/events/role.events.js';
import { ADMIN_USER_EVENTS } from '../users/events/admin-user.events.js';

/** Any change to users, roles or keys makes cached principals stale (one decorator per event). */
@Injectable()
export class AuthCacheListener {
  constructor(private readonly resolver: PrincipalResolver) {}

  @OnEvent(ADMIN_USER_EVENTS.UPDATED, { async: true, promisify: true })
  @OnEvent(ADMIN_USER_EVENTS.DELETED, { async: true, promisify: true })
  @OnEvent(ADMIN_USER_EVENTS.PASSWORD_CHANGED, { async: true, promisify: true })
  @OnEvent(ROLE_EVENTS.UPDATED, { async: true, promisify: true })
  @OnEvent(ROLE_EVENTS.DELETED, { async: true, promisify: true })
  @OnEvent(API_KEY_EVENTS.REVOKED, { async: true, promisify: true })
  invalidate(): Promise<void> {
    return this.resolver.invalidateAll();
  }
}
