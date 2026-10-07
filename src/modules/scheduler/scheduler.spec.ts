import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { SchedulerController } from './scheduler.controller.js';
import { SchedulerListener } from './scheduler.listener.js';
import {
  SchedulerBootstrap,
  SchedulerProcessor,
} from './scheduler.processor.js';
import { SchedulerService } from './scheduler.service.js';

describe('scheduler', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return {
      svc: new SchedulerService(prisma as never, fb.bus),
      prisma,
      ...fb,
    };
  }
  const req = (runAt: string | null) => ({
    targetType: 'PAGE' as const,
    targetId: 'p',
    action: 'PUBLISH' as const,
    runAt,
  });

  it('upserts pending schedules and cancels cleared ones', async () => {
    const { svc, prisma, afterNames } = setup();
    await svc.apply([], null);
    expect(afterNames()).toEqual([]);
    await svc.apply([req('2026-11-01T00:00:00.000Z'), req(null)], 'u1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        targetType: 'PAGE',
        targetId: 'p',
        action: 'PUBLISH',
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
    expect(afterNames()).toEqual(['schedule.changed']);
  });

  it('claims due rows in batches and hands them to the owners', async () => {
    const { svc, prisma, after } = setup();
    const row = (i: number) => ({
      id: `s${i}`,
      targetType: 'BANNER',
      targetId: `b${i}`,
      action: 'UNPUBLISH',
      runAt: new Date('2026-10-01T00:00:00Z'),
    });
    prisma.$queryRaw
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => row(i)))
      .mockResolvedValueOnce([row(100)])
      .mockResolvedValueOnce([]);
    expect(await svc.runDue(new Date('2026-10-02T00:00:00Z'))).toBe(101);
    expect(after).toHaveLength(101);
    expect(after[0]).toMatchObject({
      name: 'schedule.due',
      data: { scheduleId: 's0', targetType: 'BANNER', action: 'UNPUBLISH' },
    });
    expect(prisma.schedule.updateMany).toHaveBeenCalledTimes(2);
    expect(await svc.runDue()).toBe(0);
  });

  it('lists schedules with filters', async () => {
    const { svc, prisma } = setup();
    prisma.schedule.count.mockResolvedValue(1);
    prisma.schedule.findMany.mockResolvedValue([
      { id: 's', targetType: 'PAGE', targetId: 'p1' },
      { id: 't', targetType: 'BANNER', targetId: 'gone' },
    ]);
    prisma.page.findMany.mockResolvedValue([
      { id: 'p1', translations: [{ title: '' }, { title: 'About us' }] },
    ]);
    const q = Object.assign(
      new (class {
        page = 1;
        limit = 25;
        order = 'asc' as const;
        skip = 0;
      })(),
      { status: 'PENDING' as const },
    );
    expect(await svc.list(q as never)).toEqual({
      data: [
        {
          id: 's',
          targetType: 'PAGE',
          targetId: 'p1',
          targetLabel: 'About us',
        },
        { id: 't', targetType: 'BANNER', targetId: 'gone', targetLabel: null },
      ],
      total: 1,
      page: 1,
      limit: 25,
    });
    expect(prisma.schedule.findMany.mock.calls[0][0].where.status).toBe(
      'PENDING',
    );
  });

  it('wires the listener, processor, bootstrap and controller', async () => {
    const svc = {
      apply: vi.fn(async () => undefined),
      runDue: vi.fn(async () => 2),
      list: vi.fn(async () => 'list'),
    };
    await new SchedulerListener(svc as never).onRequested({
      data: { requests: [req(null)], actorId: null },
    } as never);
    expect(svc.apply).toHaveBeenCalledWith([req(null)], null);
    const proc = new SchedulerProcessor(svc as never);
    expect(
      await proc.process({ name: 'scheduler-run-due', data: {} } as never),
    ).toEqual({ ran: 2 });
    expect(await proc.process({ name: 'nope', data: {} } as never)).toEqual({
      skipped: 'unknown job nope',
    });
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new SchedulerBootstrap(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'run-due-schedules',
      { every: 60_000 },
      expect.objectContaining({ name: 'scheduler-run-due' }),
    );
    expect(await new SchedulerController(svc as never).list({} as never)).toBe(
      'list',
    );
  });
});
