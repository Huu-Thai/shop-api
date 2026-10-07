import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../database/generated/prisma/client.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { type AnyFn, fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { JobExecutor } from './job-executor.js';
import {
  JobCanceledError,
  type JobContext,
  type JobRunner,
  params,
  principalOf,
} from './job-handler.js';
import { JobRegistry } from './job-registry.js';
import { JobSchedules } from './job-schedules.js';
import { JobsController } from './jobs.controller.js';
import { JobsHousekeeping } from './jobs-housekeeping.js';
import { JobsProcessor, JobsScheduler } from './jobs.processor.js';
import {
  assertSchedule,
  JobsService,
  nextRun,
  safeName,
} from './jobs.service.js';

const READER = { ...ROOT, permissions: ['jobs:write', 'catalog:read'] };

function runner(info: Partial<JobRunner['info']> = {}, run?: AnyFn): JobRunner {
  return {
    info: {
      type: 'export.things',
      title: 'Export things',
      description: 'd',
      permission: 'catalog:read',
      ...info,
    },
    validate: vi.fn(async (p: Record<string, unknown>) => {
      if (p.bad) throw new BadRequestException('bad param');
      return { ...p, normalised: true };
    }),
    run: vi.fn(run ?? (async () => ({ stats: { rows: 1 } }))),
  };
}

function registry(...runners: JobRunner[]) {
  const discovery = {
    getProviders: vi.fn(() => [
      ...runners.map((r) => ({ instance: r })),
      { instance: undefined },
      { instance: {} },
    ]),
  };
  const reg = new JobRegistry(discovery as never);
  reg.onModuleInit();
  return reg;
}

const jobRow = (extra = {}) => ({
  id: 'j1',
  code: 'nightly',
  name: 'Nightly',
  type: 'export.things',
  params: {},
  cron: '0 2 * * *',
  timezone: 'UTC',
  isActive: true,
  lastRunAt: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const execRow = (extra = {}) => ({
  id: 'e1',
  jobId: null,
  type: 'export.things',
  status: 'QUEUED',
  trigger: 'MANUAL',
  params: {},
  progress: 0,
  stats: {},
  errors: [],
  error: null,
  outputName: null,
  cancelRequested: false,
  actorLabel: 'root',
  createdAt: new Date(),
  startedAt: null,
  finishedAt: null,
  ...extra,
});

function setup(...runners: JobRunner[]) {
  const prisma = fakePrisma();
  const b = fakeBus(prisma);
  const reg = registry(...(runners.length ? runners : [runner()]));
  const storage = {
    putObject: vi.fn<AnyFn>(async () => undefined),
    getObject: vi.fn<AnyFn>(async () => Buffer.from('sku\nA\n')),
    deleteObjects: vi.fn<AnyFn>(async (keys: string[]) => ({
      deleted: keys,
      failed: [],
    })),
    getSignedUrl: vi.fn<AnyFn>(async () => 'https://signed'),
  };
  const queue = {
    add: vi.fn<AnyFn>(),
    remove: vi.fn<AnyFn>(async () => 1),
    upsertJobScheduler: vi.fn<AnyFn>(),
    removeJobScheduler: vi.fn<AnyFn>(),
    getJobSchedulers: vi.fn<AnyFn>(async () => []),
    getJobState: vi.fn<AnyFn>(async () => 'unknown'),
  };
  const svc = new JobsService(
    prisma as never,
    b.bus,
    reg,
    storage as never,
    queue as never,
  );
  prisma.jobExecution.create.mockImplementation(async (a: { data: object }) =>
    execRow(a.data),
  );
  return { prisma, b, reg, storage, queue, svc };
}

describe('job helpers', () => {
  it('validates schedules and time zones', () => {
    expect(() => assertSchedule('0 2 * * *', 'Asia/Ho_Chi_Minh')).not.toThrow();
    expect(() => assertSchedule(null, 'UTC')).not.toThrow();
    expect(() => assertSchedule('0 2 * *', 'UTC')).toThrow('five fields');
    expect(() => assertSchedule('0 25 * * *', 'UTC')).toThrow('Invalid cron');
    expect(() => assertSchedule('0 2 * * *', 'Mars/Base')).toThrow(
      'Unknown time zone',
    );
    expect(
      nextRun('0 2 * * *', 'UTC', new Date('2026-11-21T03:00:00Z')),
    ).toEqual(new Date('2026-11-22T02:00:00Z'));
    expect(
      nextRun(
        '0 2 * * *',
        'Asia/Ho_Chi_Minh',
        new Date('2026-11-21T03:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-21T19:00:00Z'));
    expect(safeName('../my file (1).csv')).toBe('_my_file_1_.csv');
    expect(safeName('***')).toBe('_');
  });

  it('parameter helpers explain what is wrong', () => {
    expect(() => params.only({ a: 1, b: 2 }, ['a'])).toThrow(
      'Unknown parameter(s): b (allowed: a)',
    );
    expect(() => params.only({ a: 1 }, [])).toThrow('this job takes none');
    expect(params.uuids({}, 'ids')).toBeUndefined();
    expect(() => params.uuids({ ids: ['x'] }, 'ids')).toThrow('list of ids');
    expect(params.string({ s: 'ok' }, 's', { pattern: /^o/ })).toBe('ok');
    expect(params.string({ s: '' }, 's')).toBeUndefined();
    expect(() => params.string({}, 's', { required: true })).toThrow(
      's is required',
    );
    expect(() => params.string({ s: 5 }, 's')).toThrow('s is not valid');
    expect(params.oneOf({}, 'm', ['a', 'b'], 'a')).toBe('a');
    expect(() => params.oneOf({ m: 'c' }, 'm', ['a', 'b'], 'a')).toThrow(
      'one of a, b',
    );
    expect(params.date({ d: '2026-11-21' }, 'd')).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    expect(params.date({}, 'd')).toBeUndefined();
    expect(() => params.date({ d: 'soon' }, 'd')).toThrow('ISO date');
  });

  it('writing handlers act as whoever started them', () => {
    const ctx = (type: string) =>
      ({ actor: { type, id: 'a1', label: 'x' } }) as unknown as JobContext;
    expect(principalOf(ctx('admin'), 'catalog:write')).toEqual({
      type: 'admin',
      id: 'a1',
      label: 'x',
      permissions: ['catalog:write'],
    });
    expect(principalOf(ctx('api-key'), 'p').type).toBe('api-key');
    expect(() => principalOf(ctx('system'), 'p')).toThrow(
      'started by an admin or an API key',
    );
  });

  it('the registry finds handlers and refuses duplicates', () => {
    const reg = registry(runner(), runner({ type: 'a.first' }));
    expect(reg.types().map((t) => t.type)).toEqual([
      'a.first',
      'export.things',
    ]);
    expect(reg.has('a.first')).toBe(true);
    expect(() => reg.get('nope')).toThrow('Unknown job type "nope"');
    expect(() => registry(runner(), runner())).toThrow('registered twice');
  });
});

describe('JobsService definitions', () => {
  it('creates jobs after checking type, permission, input, schedule and params', async () => {
    const { svc, prisma, b } = setup(
      runner(),
      runner({
        type: 'import.things',
        input: 'csv',
        permission: 'catalog:write',
      }),
    );
    prisma.job.create.mockImplementation(async (a: { data: object }) =>
      jobRow(a.data),
    );
    const j = await svc.create(
      {
        code: 'nightly',
        name: 'Nightly',
        type: 'export.things',
        cron: ' 0 2 * * * ',
        params: { a: 1 },
      },
      READER,
    );
    expect(prisma.job.create.mock.calls[0][0].data).toMatchObject({
      cron: '0 2 * * *',
      timezone: 'UTC',
      params: { a: 1, normalised: true },
      createdById: ROOT.id,
    });
    expect(j.nextRunAt).toBeInstanceOf(Date);
    expect(b.afterNames()).toEqual(['job.created']);
    await expect(
      svc.create({ code: 'x', name: 'x', type: 'import.things' }, ROOT),
    ).rejects.toThrow('POST /admin/imports');
    await expect(
      svc.create(
        { code: 'x', name: 'x', type: 'export.things' },
        { ...ROOT, permissions: ['jobs:write'] },
      ),
    ).rejects.toThrow('needs the catalog:read permission');
    await expect(
      svc.create(
        { code: 'x', name: 'x', type: 'export.things', params: { bad: 1 } },
        ROOT,
      ),
    ).rejects.toThrow('bad param');
    await expect(
      svc.create({ code: 'x', name: 'x', type: 'nope' }, ROOT),
    ).rejects.toThrow('Unknown job type');
    prisma.job.create.mockImplementation(async (a: { data: object }) =>
      jobRow({ ...a.data, cron: null }),
    );
    expect(
      (
        await svc.create(
          { code: 'y', name: 'y', type: 'export.things', isActive: false },
          { ...ROOT, type: 'api-key' },
        )
      ).nextRunAt,
    ).toBeNull();
    expect(prisma.job.create.mock.calls[1][0].data.createdById).toBeNull();
  });

  it('lists, reads, updates and deletes', async () => {
    const { svc, prisma, b } = setup();
    prisma.job.findMany.mockResolvedValue([
      jobRow(),
      jobRow({ id: 'j2', isActive: false }),
    ]);
    expect((await svc.list()).map((j) => j.nextRunAt === null)).toEqual([
      false,
      true,
    ]);
    prisma.job.findUnique.mockResolvedValue(jobRow());
    expect((await svc.get('j1')).code).toBe('nightly');
    prisma.job.update.mockImplementation(async (a: { data: object }) =>
      jobRow(a.data),
    );
    await svc.update('j1', { cron: null, params: { x: 1 } }, ROOT);
    expect(prisma.job.update.mock.calls[0][0].data).toMatchObject({
      cron: null,
      params: { x: 1, normalised: true },
    });
    expect(b.afterNames()).toEqual(['job.updated']);
    prisma.job.update.mockImplementation(async () => jobRow());
    await svc.update('j1', { name: 'Nightly' }, ROOT);
    expect(b.afterNames()).toHaveLength(1);
    await svc.remove('j1', ROOT);
    expect(b.afterNames()).toEqual(['job.updated', 'job.deleted']);
    prisma.job.findUnique.mockResolvedValue(null);
    await expect(svc.get('j9')).rejects.toThrow('not found');
  });
});

describe('JobsService executions', () => {
  it('runs a defined job now, or a type once; queue message id = execution id', async () => {
    const { svc, prisma, queue, b } = setup();
    prisma.job.findUnique.mockResolvedValue(jobRow({ params: { a: 1 } }));
    const e = await svc.run('j1', ROOT);
    expect(prisma.jobExecution.create.mock.calls[0][0].data).toMatchObject({
      jobId: 'j1',
      trigger: 'MANUAL',
      actorType: 'admin',
      actorId: ROOT.id,
      params: { a: 1 },
    });
    expect(prisma.job.update).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'job-execute',
      { executionId: e.id },
      expect.objectContaining({ jobId: e.id, attempts: 1 }),
    );
    expect(b.afterNames()).toEqual(['job-execution.queued']);
    await svc.start({ type: 'export.things', params: { b: 2 } }, ROOT);
    expect(prisma.jobExecution.create.mock.calls[1][0].data).toMatchObject({
      jobId: null,
      params: { b: 2, normalised: true },
    });
  });

  it('imports store the file, then queue; the file is removed if that fails', async () => {
    const { svc, storage, prisma } = setup(
      runner({
        type: 'import.things',
        input: 'csv',
        permission: 'catalog:write',
      }),
      runner(),
    );
    const file = {
      buffer: Buffer.from('sku\nA\n'),
      originalname: 'my prices.csv',
      size: 6,
    };
    await svc.startImport(
      file,
      { type: 'import.things', params: '{"a":1}' },
      ROOT,
      1000,
    );
    expect(storage.putObject.mock.calls[0][0]).toMatch(
      /^job-inputs\/[0-9a-f-]{36}\/my_prices.csv$/,
    );
    expect(prisma.jobExecution.create.mock.calls[0][0].data.inputKey).toBe(
      storage.putObject.mock.calls[0][0],
    );
    const refused: [unknown, object, string][] = [
      [undefined, { type: 'import.things' }, 'Attach the CSV'],
      [{ ...file, size: 5000 }, { type: 'import.things' }, 'larger than'],
      [
        { ...file, buffer: Buffer.from([0x50, 0x4b, 0, 4]) },
        { type: 'import.things' },
        'not a text',
      ],
      [file, { type: 'export.things' }, 'not an import'],
      [file, { type: 'import.things', params: '{' }, 'JSON object'],
      [file, { type: 'import.things', params: '[1]' }, 'JSON object'],
    ];
    for (const [f, body, msg] of refused)
      await expect(
        svc.startImport(f as never, body as never, ROOT, 1000),
      ).rejects.toThrow(msg);
    prisma.jobExecution.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      svc.startImport(file, { type: 'import.things' }, ROOT, 1000),
    ).rejects.toThrow('db down');
    expect(storage.deleteObjects).toHaveBeenCalledTimes(1);
    await expect(svc.start({ type: 'import.things' }, ROOT)).rejects.toThrow(
      'needs an uploaded file',
    );
  });

  it('lists and reads executions', async () => {
    const { svc, prisma } = setup();
    prisma.jobExecution.findMany.mockResolvedValue([execRow()]);
    prisma.jobExecution.count.mockResolvedValue(1);
    const page = await svc.executions({
      page: 1,
      limit: 10,
      skip: 0,
      order: 'desc',
      status: 'QUEUED',
    } as never);
    expect(page.total).toBe(1);
    prisma.jobExecution.findUnique.mockResolvedValue(null);
    await expect(svc.execution('e9')).rejects.toThrow('not found');
  });

  it('cancels queued runs at once and asks running ones to stop', async () => {
    const { svc, prisma, queue, b } = setup();
    prisma.jobExecution.findUnique.mockResolvedValue(execRow());
    prisma.jobExecution.updateMany.mockResolvedValueOnce({ count: 1 });
    await svc.cancel('e1', ROOT);
    expect(queue.remove).toHaveBeenCalledWith('e1');
    expect(b.afterNames()).toEqual([
      'job-execution.cancel-requested',
      'job-execution.canceled',
    ]);
    prisma.jobExecution.findUnique.mockResolvedValue(
      execRow({ status: 'RUNNING' }),
    );
    prisma.jobExecution.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await svc.cancel('e1', ROOT);
    expect(prisma.jobExecution.updateMany.mock.calls[2][0].data).toEqual({
      cancelRequested: true,
    });
    expect(b.afterNames()).toHaveLength(3);
    prisma.jobExecution.findUnique.mockResolvedValue(
      execRow({ status: 'SUCCEEDED' }),
    );
    await expect(svc.cancel('e1', ROOT)).rejects.toThrow('already succeeded');
  });

  it('hands out short-lived download links for export files', async () => {
    const { svc, prisma, storage } = setup();
    prisma.jobExecution.findUnique.mockResolvedValue({
      type: 'export.things',
      outputKey: 'k',
      outputName: 'x.csv',
    });
    expect(await svc.download('e1', ROOT)).toEqual({
      url: 'https://signed',
      name: 'x.csv',
    });
    expect(storage.getSignedUrl).toHaveBeenCalledWith('k', 300, 'x.csv');
    prisma.jobExecution.findUnique.mockResolvedValue({
      type: 'export.things',
      outputKey: null,
      outputName: null,
    });
    await expect(svc.download('e1', ROOT)).rejects.toThrow('has no file');
    prisma.jobExecution.findUnique.mockResolvedValue(null);
    await expect(svc.download('e1', ROOT)).rejects.toThrow('not found');
  });
});

describe('JobExecutor', () => {
  function exec(r: JobRunner) {
    const s = setup(r);
    const executor = new JobExecutor(
      s.prisma as never,
      s.b.bus,
      s.reg,
      s.storage as never,
    );
    s.prisma.jobExecution.updateMany.mockResolvedValue({ count: 1 });
    s.prisma.jobExecution.findUnique.mockImplementation(
      async (a: { select: Record<string, unknown> }) =>
        a.select.cancelRequested && Object.keys(a.select).length === 1
          ? { cancelRequested: false }
          : {
              id: 'e1',
              jobId: 'j1',
              type: r.info.type,
              status: 'RUNNING',
              params: { p: 1 },
              inputKey: 'in.csv',
              actorType: 'admin',
              actorId: 'a1',
              actorLabel: 'root',
            },
    );
    return { ...s, executor };
  }

  it('runs once, reports progress, stores the file and records the outcome', async () => {
    let clock = 0;
    const r = runner({}, async (ctx: JobContext) => {
      expect(ctx.params).toEqual({ p: 1 });
      expect(ctx.actor).toEqual({ type: 'admin', id: 'a1', label: 'root' });
      expect((await ctx.input()).toString()).toBe('sku\nA\n');
      await ctx.progress(1, 4);
      clock += 500;
      await ctx.progress(2, 4); // throttled
      clock += 3000;
      await ctx.progress(3, 4);
      ctx.rowError(3, 'bad row');
      expect(await ctx.cancelRequested()).toBe(false);
      return {
        stats: { rows: 4 },
        output: {
          name: 'x.csv',
          contentType: 'text/csv',
          body: Buffer.from('x'),
        },
      };
    });
    const { executor, prisma, storage, b } = exec(r);
    expect(await executor.execute('e1', () => clock)).toBe('SUCCEEDED');
    const progressWrites = prisma.jobExecution.updateMany.mock.calls.filter(
      (c) => c[0].data.progress !== undefined,
    );
    expect(progressWrites.map((c) => c[0].data.progress)).toEqual([25, 75]);
    expect(storage.putObject).toHaveBeenCalledWith(
      'job-executions/e1/x.csv',
      Buffer.from('x'),
      'text/csv',
      'private, no-store',
    );
    expect(prisma.jobExecution.update.mock.calls[0][0].data).toMatchObject({
      status: 'SUCCEEDED',
      progress: 100,
      stats: { rows: 4, failed: 1 },
      errors: [{ row: 3, message: 'bad row' }],
      outputKey: 'job-executions/e1/x.csv',
      outputName: 'x.csv',
    });
    expect(b.afterNames()).toEqual(['job-execution.succeeded']);
  });

  it('records failures and cancellations', async () => {
    const failing = exec(
      runner({}, async () => {
        throw new Error('disk full');
      }),
    );
    expect(await failing.executor.execute('e1')).toBe('FAILED');
    expect(
      failing.prisma.jobExecution.update.mock.calls[0][0].data,
    ).toMatchObject({ status: 'FAILED', error: 'disk full' });
    expect(failing.b.afterNames()).toEqual(['job-execution.failed']);
    const canceled = exec(
      runner({}, async () => {
        throw new JobCanceledError();
      }),
    );
    expect(await canceled.executor.execute('e1')).toBe('CANCELED');
    expect(canceled.b.afterNames()).toEqual(['job-execution.canceled']);
  });

  it('a cancellation noticed by the handler stops it', async () => {
    const r = runner({}, async (ctx: JobContext) => {
      if (await ctx.cancelRequested()) throw new Error('stopping');
      return { stats: {} };
    });
    const s = exec(r);
    s.prisma.jobExecution.findUnique.mockImplementation(
      async (a: { select: Record<string, unknown> }) =>
        Object.keys(a.select).length === 1
          ? { cancelRequested: true }
          : {
              id: 'e1',
              jobId: null,
              type: 'export.things',
              status: 'RUNNING',
              params: {},
              inputKey: null,
              actorType: 'system',
              actorId: null,
              actorLabel: 'scheduler',
            },
    );
    expect(await s.executor.execute('e1')).toBe('CANCELED');
  });

  it('skips executions it can no longer claim; a redelivered running one failed', async () => {
    const s = exec(runner());
    s.prisma.jobExecution.updateMany.mockResolvedValue({ count: 0 });
    expect(await s.executor.execute('e1')).toBe('FAILED');
    expect(s.prisma.jobExecution.update.mock.calls[0][0].data.error).toContain(
      'worker running it stopped',
    );
    s.prisma.jobExecution.findUnique.mockResolvedValue({
      id: 'e1',
      status: 'CANCELED',
    });
    expect(await s.executor.execute('e1')).toBe('SKIPPED');
    s.prisma.jobExecution.findUnique.mockResolvedValue(null);
    expect(await s.executor.execute('e1')).toBe('SKIPPED');
  });

  it('a job without input fails clearly; abandon fails only running executions', async () => {
    const r = runner({}, async (ctx: JobContext) => {
      await ctx.input();
      return { stats: {} };
    });
    const s = exec(r);
    s.prisma.jobExecution.findUnique.mockResolvedValue({
      id: 'e1',
      jobId: null,
      type: 'export.things',
      status: 'RUNNING',
      params: {},
      inputKey: null,
      actorType: 'system',
      actorId: null,
      actorLabel: 's',
    });
    expect(await s.executor.execute('e1')).toBe('FAILED');
    expect(s.prisma.jobExecution.update.mock.calls[0][0].data.error).toBe(
      'This execution has no input file',
    );
    s.prisma.jobExecution.findUnique.mockResolvedValue({
      id: 'e1',
      jobId: null,
      type: 't',
      status: 'RUNNING',
    });
    await s.executor.abandon('e1');
    expect(s.prisma.jobExecution.update).toHaveBeenCalledTimes(2);
    s.prisma.jobExecution.findUnique.mockResolvedValue({
      id: 'e1',
      status: 'SUCCEEDED',
    });
    await s.executor.abandon('e1');
    expect(s.prisma.jobExecution.update).toHaveBeenCalledTimes(2);
  });
});

describe('jobs housekeeping, schedules and processor', () => {
  const config = {
    get: vi.fn(() => ({ fileRetentionDays: 7, historyDays: 90 })),
  };

  it('re-queues lost messages and fails abandoned runs', async () => {
    const s = setup();
    const executor = { abandon: vi.fn() };
    const h = new JobsHousekeeping(
      s.prisma as never,
      s.b.bus,
      s.storage as never,
      s.svc,
      executor as never,
      config as never,
      s.queue as never,
    );
    s.prisma.jobExecution.findMany
      .mockResolvedValueOnce([{ id: 'q1' }])
      .mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    s.queue.getJobState
      .mockResolvedValueOnce('active')
      .mockResolvedValueOnce('unknown');
    expect(await h.requeue(new Date('2026-11-21T10:00:00Z'))).toEqual({
      requeued: 1,
      abandoned: 1,
    });
    expect(
      s.prisma.jobExecution.findMany.mock.calls[0][0].where.createdAt.lt,
    ).toEqual(new Date('2026-11-21T09:58:00Z'));
    expect(executor.abandon).toHaveBeenCalledWith('r2');
  });

  it('deletes expired files, then old history', async () => {
    const s = setup();
    const h = new JobsHousekeeping(
      s.prisma as never,
      s.b.bus,
      s.storage as never,
      s.svc,
      {} as never,
      config as never,
      s.queue as never,
    );
    s.prisma.jobExecution.findMany
      .mockResolvedValueOnce([
        { id: 'e1', outputKey: 'o1', inputKey: null },
        { id: 'e2', outputKey: null, inputKey: 'i2' },
      ])
      .mockResolvedValueOnce([]);
    s.storage.deleteObjects.mockResolvedValueOnce({
      deleted: ['o1'],
      failed: ['i2'],
    });
    s.prisma.jobExecution.deleteMany.mockResolvedValue({ count: 3 });
    expect(await h.cleanup(new Date('2026-11-21T00:00:00Z'))).toEqual({
      files: 2,
      executions: 3,
    });
    expect(
      s.prisma.jobExecution.findMany.mock.calls[0][0].where.finishedAt.lt,
    ).toEqual(new Date('2026-11-14T00:00:00Z'));
    expect(s.prisma.jobExecution.updateMany.mock.calls[0][0].data).toEqual({
      outputKey: null,
      inputKey: null,
    });
    expect(
      s.prisma.jobExecution.deleteMany.mock.calls[0][0].where.finishedAt.lt,
    ).toEqual(new Date('2026-08-23T00:00:00Z'));
  });

  it('keeps one scheduler per active cron job and removes stale ones', async () => {
    const s = setup();
    const sch = new JobSchedules(s.prisma as never, s.queue as never);
    s.prisma.job.findUnique
      .mockResolvedValueOnce({
        cron: '0 2 * * *',
        timezone: 'Asia/Ho_Chi_Minh',
        isActive: true,
      })
      .mockResolvedValueOnce(null);
    await sch.onJobChanged({ data: { jobId: 'j1' } } as never);
    expect(s.queue.upsertJobScheduler).toHaveBeenCalledWith(
      'job:j1',
      { pattern: '0 2 * * *', tz: 'Asia/Ho_Chi_Minh' },
      expect.objectContaining({
        name: 'job-run-scheduled',
        data: { jobId: 'j1' },
      }),
    );
    expect(await sch.sync('j1')).toBe('unscheduled');
    expect(s.queue.removeJobScheduler).toHaveBeenCalledWith('job:j1');
    s.prisma.job.findMany.mockResolvedValue([{ id: 'j1' }, { id: 'j2' }]);
    s.prisma.job.findUnique
      .mockResolvedValueOnce({
        cron: '* * * * *',
        timezone: 'UTC',
        isActive: true,
      })
      .mockResolvedValueOnce({ cron: null, timezone: 'UTC', isActive: true });
    s.queue.getJobSchedulers.mockResolvedValue([
      { key: 'job:j1' },
      { key: 'job:gone' },
      { key: 'purge-carts' },
      { key: 'jobs-cleanup' },
    ]);
    expect(await sch.reconcile()).toEqual({ scheduled: 1, removed: 2 });
  });

  it('dispatches messages; scheduled runs skip while the previous one is open', async () => {
    const s = setup();
    const executor = { execute: vi.fn(async () => 'SUCCEEDED') };
    const schedules = { sync: vi.fn() };
    const housekeeping = {
      requeue: vi.fn(async () => ({ requeued: 0, abandoned: 0 })),
      cleanup: vi.fn(async () => ({ files: 0, executions: 0 })),
    };
    const p = new JobsProcessor(
      s.prisma as never,
      s.svc,
      executor as never,
      schedules as never,
      housekeeping as never,
    );
    const job = (name: string, data: object = {}) =>
      ({ id: '1', name, data, queueName: 'jobs' }) as never;
    expect(await p.process(job('job-execute', { executionId: 'e1' }))).toEqual({
      outcome: 'SUCCEEDED',
    });
    expect(await p.process(job('jobs-requeue'))).toEqual({
      requeued: 0,
      abandoned: 0,
    });
    expect(await p.process(job('jobs-cleanup'))).toEqual({
      files: 0,
      executions: 0,
    });
    expect(await p.process(job('expire-unpaid-orders'))).toEqual({
      skipped: 'unknown job expire-unpaid-orders',
    });

    s.prisma.job.findUnique.mockResolvedValueOnce(null);
    expect(await p.process(job('job-run-scheduled', { jobId: 'j1' }))).toEqual({
      skipped: 'job removed or inactive',
    });
    expect(schedules.sync).toHaveBeenCalledWith('j1');
    s.prisma.job.findUnique.mockResolvedValue(jobRow());
    const r = await p.runScheduled('j1');
    expect(r).toEqual({ executionId: 'e1' });
    expect(s.prisma.jobExecution.create.mock.calls[0][0].data).toMatchObject({
      trigger: 'SCHEDULE',
      actorType: 'system',
      actorLabel: 'scheduler',
    });
    expect(s.queue.add).toHaveBeenCalled();
    s.prisma.jobExecution.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    expect(await p.runScheduled('j1')).toEqual({
      skipped: 'previous run still open',
    });
    s.prisma.jobExecution.create.mockRejectedValueOnce(new Error('db down'));
    await expect(p.runScheduled('j1')).rejects.toThrow('db down');
  });

  it('the worker reconciles schedules and registers housekeeping', async () => {
    const queue = { upsertJobScheduler: vi.fn() };
    const schedules = { reconcile: vi.fn() };
    await new JobsScheduler(
      queue as never,
      schedules as never,
    ).onApplicationBootstrap();
    expect(schedules.reconcile).toHaveBeenCalled();
    expect(queue.upsertJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'jobs-requeue',
      'jobs-cleanup',
    ]);
  });

  it('the controller delegates every route', async () => {
    const config2 = { get: () => ({ importMaxBytes: 10 }) };
    const ctrl = new JobsController(stubService() as never, config2 as never);
    expect(await exerciseController(ctrl)).toEqual({ ok: 13, failed: 0 });
  });
});
