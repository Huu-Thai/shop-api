import { SYSTEM_ACTOR } from '../../../common/auth/principal.js';
import { requestContext } from '../../../logger/request-context.js';
import { RoleCreatedEvent } from '../roles/events/role.events.js';
import { AuditListener } from './audit.listener.js';
import { AuditLogsService } from './audit-logs.service.js';

describe('AuditListener', () => {
  it('records audited events with the request id and IP captured at construction', async () => {
    const create = vi.fn(async () => ({}));
    const listener = new AuditListener({
      auditLog: { createMany: create },
    } as never);
    const event = requestContext.run(
      { requestId: 'req-1', ip: '10.1.1.1' },
      () =>
        new RoleCreatedEvent(SYSTEM_ACTOR, 'r1', 'editor', ['catalog:read']),
    );
    event.eventId = '00000000-0000-4000-8000-0000000000e1';
    await listener.record(event); // outside the request: values must come from the event
    expect(create).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: expect.objectContaining({
        eventId: '00000000-0000-4000-8000-0000000000e1',
        action: 'role.created',
        entityType: 'role',
        entityId: 'r1',
        actorType: 'system',
        requestId: 'req-1',
        ip: '10.1.1.1',
      }),
    });
  });

  it('ignores non-audited events and never throws on DB failure', async () => {
    const create = vi.fn(async () => {
      throw new Error('db down');
    });
    const listener = new AuditListener({
      auditLog: { createMany: create },
    } as never);
    await listener.record({ name: 'outbox.ping' });
    expect(create).not.toHaveBeenCalled();
    await expect(
      listener.record(new RoleCreatedEvent(SYSTEM_ACTOR, 'r1', 'editor', [])),
    ).resolves.toBeUndefined();
  });
});

describe('AuditLogsService', () => {
  it('filters by exact action, action prefix and time range', async () => {
    const findMany = vi.fn(async (_args: unknown) => []);
    const count = vi.fn(async () => 0);
    const svc = new AuditLogsService({
      auditLog: { findMany, count },
    } as never);
    const q = { page: 1, limit: 20, skip: 0, order: 'desc' } as never;
    await svc.list({
      ...(q as object),
      action: 'role.',
      from: '2026-01-01T00:00:00Z',
    } as never);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        action: { startsWith: 'role.' },
        createdAt: { gte: new Date('2026-01-01T00:00:00Z') },
      },
    });
    await svc.list({ ...(q as object), action: 'role.created' } as never);
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { action: 'role.created' },
    });
  });
});
