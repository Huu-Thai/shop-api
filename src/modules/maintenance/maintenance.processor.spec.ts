import type { Job } from 'bullmq';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { PROCESSORS, WorkerModule } from '../../worker.module.js';
import {
  MaintenanceProcessor,
  MaintenanceScheduler,
  REFRESH_TOKEN_GRACE_DAYS,
} from './maintenance.processor.js';

const job = (name: string) =>
  ({
    id: '1',
    name,
    data: {},
    queueName: QUEUES.MAINTENANCE,
  }) as unknown as Job;

const config = (retentionDays: number) =>
  ({ get: () => ({ retentionDays }) }) as never;

describe('MaintenanceProcessor', () => {
  it('purges audit rows past the retention period; 0 keeps them', async () => {
    const $executeRaw = vi
      .fn()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(3);
    const now = new Date('2026-11-21T02:45:00Z');
    const p = new MaintenanceProcessor({ $executeRaw } as never, config(30));
    expect(await p.purgeAuditLogs(now)).toBe(5003);
    expect($executeRaw.mock.calls[0][1]).toEqual(
      new Date('2026-10-22T02:45:00Z'),
    );
    const keep = new MaintenanceProcessor({ $executeRaw } as never, config(0));
    expect(await keep.purgeAuditLogs(now)).toBe(0);
    expect($executeRaw).toHaveBeenCalledTimes(2);
  });

  it('purges in batches until a short batch, with a grace-period cutoff', async () => {
    const $executeRaw = vi
      .fn()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(12);
    const p = new MaintenanceProcessor({ $executeRaw } as never, config(365));
    const now = new Date('2026-10-03T03:15:00Z');
    expect(await p.purgeRefreshTokens(now)).toBe(10_012);
    expect($executeRaw).toHaveBeenCalledTimes(3);
    const cutoff = $executeRaw.mock.calls[0][1] as Date;
    expect(now.getTime() - cutoff.getTime()).toBe(
      REFRESH_TOKEN_GRACE_DAYS * 86_400_000,
    );
  });

  it('dispatches by job name', async () => {
    const p = new MaintenanceProcessor(
      { $executeRaw: vi.fn(async () => 0) } as never,
      config(365),
    );
    expect(await p.process(job(JOBS.PURGE_REFRESH_TOKENS))).toEqual({
      purged: 0,
    });
    expect(await p.process(job(JOBS.AUDIT_PURGE))).toEqual({ purged: 0 });
    expect(await p.process(job('mystery'))).toEqual({
      skipped: 'unknown job mystery',
    });
  });

  it('schedules the daily purge idempotently', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new MaintenanceScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'purge-refresh-tokens-daily',
      { pattern: '15 3 * * *', tz: 'UTC' },
      expect.objectContaining({ name: JOBS.PURGE_REFRESH_TOKENS }),
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'purge-audit-logs-daily',
      { pattern: '45 2 * * *', tz: 'UTC' },
      expect.objectContaining({ name: JOBS.AUDIT_PURGE }),
    );
  });
});

describe('WorkerModule.forQueues', () => {
  it('runs all processors by default and only the selected queues otherwise', () => {
    expect(WorkerModule.forQueues([]).providers).toEqual(
      Object.values(PROCESSORS).flat(),
    );
    expect(WorkerModule.forQueues([QUEUES.MEDIA]).providers).toEqual(
      PROCESSORS[QUEUES.MEDIA],
    );
    expect(WorkerModule.forQueues([QUEUES.MAINTENANCE]).providers).toContain(
      MaintenanceProcessor,
    );
  });

  it('fails fast on a typo in WORKER_QUEUES', () => {
    expect(() => WorkerModule.forQueues(['maintenence'])).toThrow(
      'unknown queues: maintenence',
    );
  });
});
