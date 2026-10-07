import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { API_KEY_EVENTS } from '../../modules/admin/api-keys/events/api-key.events.js';
import { AuditListener } from '../../modules/admin/audit/audit.listener.js';
import { AuthCacheListener } from '../../modules/admin/audit/auth-cache.listener.js';
import {
  ROLE_EVENTS,
  RoleUpdatedEvent,
} from '../../modules/admin/roles/events/role.events.js';
import { ADMIN_USER_EVENTS } from '../../modules/admin/users/events/admin-user.events.js';
import { PrincipalResolver } from '../auth/principal.resolver.js';
import { SYSTEM_ACTOR } from '../auth/principal.js';

/**
 * Wires listeners through the REAL Nest event subsystem (same EventEmitter options as
 * EventsModule). Guards against registrations that look right but never fire — e.g.
 * `@OnEvent([a, b])`, which wildcard mode treats as the single namespaced event "a.b".
 */
describe('event listener wiring', () => {
  async function build() {
    const resolver = { invalidateAll: vi.fn(async () => undefined) };
    const prisma = { auditLog: { createMany: vi.fn(async () => ({})) } };
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        AuthCacheListener,
        AuditListener,
        { provide: PrincipalResolver, useValue: resolver },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    await moduleRef.init();
    return {
      events: moduleRef.get(EventEmitter2),
      resolver,
      prisma,
      moduleRef,
    };
  }

  it('every user / role / key change invalidates cached principals (stacked @OnEvent)', async () => {
    const { events, resolver, moduleRef } = await build();
    for (const name of [
      ADMIN_USER_EVENTS.UPDATED,
      ADMIN_USER_EVENTS.DELETED,
      ADMIN_USER_EVENTS.PASSWORD_CHANGED,
      ROLE_EVENTS.UPDATED,
      ROLE_EVENTS.DELETED,
      API_KEY_EVENTS.REVOKED,
    ])
      await events.emitAsync(name, {});
    expect(resolver.invalidateAll).toHaveBeenCalledTimes(6);
    await moduleRef.close();
  });

  it('the audit listener receives events of any module via the "**" wildcard, and ignores non-audited ones', async () => {
    const { events, prisma, moduleRef } = await build();
    await events.emitAsync(
      ROLE_EVENTS.UPDATED,
      new RoleUpdatedEvent(SYSTEM_ACTOR, 'r1', {
        name: { from: 'a', to: 'b' },
      }),
    );
    await events.emitAsync('catalog.product.updated', { not: 'audited' });
    expect(prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    expect(
      (prisma.auditLog.createMany.mock.calls[0] as unknown[])[0],
    ).toMatchObject({
      data: {
        action: 'role.updated',
        entityType: 'role',
        entityId: 'r1',
        actorType: 'system',
        actorLabel: 'system',
      },
    });
    await moduleRef.close();
  });
});
