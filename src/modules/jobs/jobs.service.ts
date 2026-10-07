import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CronExpressionParser } from 'cron-parser';
import { hasPermission } from '../../common/auth/permissions.js';
import {
  actorOf,
  type ActorRef,
  type Principal,
} from '../../common/auth/principal.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { diff } from '../../common/events/audited.event.js';
import {
  Prisma,
  type JobTrigger,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS, type JobExecuteJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StorageService } from '../../storage/storage.service.js';
import type {
  CreateJobDto,
  DownloadDto,
  ExecutionDto,
  JobDto,
  JobTypeDto,
  ListExecutionsQueryDto,
  RunJobDto,
  UpdateJobDto,
} from './dto/jobs.dto.js';
import { JobRegistry } from './job-registry.js';
import type { JobRunner } from './job-handler.js';
import {
  EXECUTION_EVENTS,
  type ExecutionEventData,
  JOB_EVENTS,
} from './jobs.events.js';

/** Signed download links of export files live this long. */
const DOWNLOAD_TTL_S = 300;

export const EXECUTION_SELECT = {
  id: true,
  jobId: true,
  type: true,
  status: true,
  trigger: true,
  params: true,
  progress: true,
  stats: true,
  errors: true,
  error: true,
  outputName: true,
  cancelRequested: true,
  actorLabel: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const satisfies Prisma.JobExecutionSelect;

type ExecutionRow = Prisma.JobExecutionGetPayload<{
  select: typeof EXECUTION_SELECT;
}>;
type JobRow = Prisma.JobGetPayload<object>;

/** A file name safe for object keys and Content-Disposition. */
export const safeName = (name: string) =>
  name
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100) || 'file';

export const schedulerId = (jobId: string) => `job:${jobId}`;

/** A five-field cron expression's next run, or null (invalid input throws). */
export function nextRun(
  cron: string,
  timezone: string,
  from = new Date(),
): Date {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: from })
    .next()
    .toDate();
}

export function assertSchedule(
  cron: string | null | undefined,
  timezone: string,
): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestException(`Unknown time zone "${timezone}"`);
  }
  if (cron == null) return;
  if (cron.trim().split(/\s+/).length !== 5)
    throw new BadRequestException(
      'cron must have five fields: minute hour day-of-month month day-of-week',
    );
  try {
    nextRun(cron, timezone);
  } catch (e) {
    throw new BadRequestException(
      `Invalid cron expression: ${(e as Error).message}`,
    );
  }
}

const toExecution = (r: ExecutionRow): ExecutionDto => ({
  ...r,
  params: r.params as Record<string, unknown>,
  stats: r.stats as Record<string, number>,
  errors: r.errors as unknown as ExecutionDto['errors'],
});

/**
 * Jobs (PLAN.md §5): defined jobs (a registered type, parameters, an optional cron schedule) and
 * their executions. Running anything needs `jobs:write` plus the type's own permission, so an
 * export of customers is never available to someone who can't read customers.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly registry: JobRegistry,
    private readonly storage: StorageService,
    @InjectQueue(QUEUES.JOBS) private readonly queue: Queue,
  ) {}

  types(): JobTypeDto[] {
    return this.registry.types();
  }

  private runnerFor(type: string, principal: Principal): JobRunner {
    const runner = this.registry.get(type);
    if (!hasPermission(principal.permissions, runner.info.permission))
      throw new ForbiddenException(
        `Running ${type} needs the ${runner.info.permission} permission`,
      );
    return runner;
  }

  private toJob(j: JobRow): JobDto {
    return {
      id: j.id,
      code: j.code,
      name: j.name,
      type: j.type,
      params: j.params as Record<string, unknown>,
      cron: j.cron,
      timezone: j.timezone,
      isActive: j.isActive,
      lastRunAt: j.lastRunAt,
      nextRunAt: j.isActive && j.cron ? nextRun(j.cron, j.timezone) : null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    };
  }

  async list(): Promise<JobDto[]> {
    const rows = await this.prisma.job.findMany({ orderBy: { code: 'asc' } });
    return rows.map((r) => this.toJob(r));
  }

  async get(id: string): Promise<JobDto> {
    return this.toJob(await this.load(id));
  }

  private async load(id: string): Promise<JobRow> {
    const j = await this.prisma.job.findUnique({ where: { id } });
    if (!j) throw new NotFoundException(`Job ${id} not found`);
    return j;
  }

  async create(dto: CreateJobDto, principal: Principal): Promise<JobDto> {
    const runner = this.runnerFor(dto.type, principal);
    if (runner.info.input)
      throw new BadRequestException(
        `${dto.type} needs an uploaded file; start it with POST /admin/imports`,
      );
    const timezone = dto.timezone ?? 'UTC';
    assertSchedule(dto.cron, timezone);
    const params = await runner.validate(dto.params ?? {});
    return this.bus.write({
      before: new BeforeWriteEvent(
        JOB_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(principal),
        dto,
      ),
      work: async (tx, after) => {
        const j = await tx.job.create({
          data: {
            code: dto.code,
            name: dto.name,
            type: dto.type,
            params: params as Prisma.InputJsonValue,
            cron: dto.cron?.trim() || null,
            timezone,
            isActive: dto.isActive ?? true,
            createdById: principal.type === 'admin' ? principal.id : null,
          },
        });
        after.add(
          new EntityEvent(
            JOB_EVENTS.CREATED,
            actorOf(principal),
            'job',
            j.id,
            { code: j.code, type: j.type, cron: j.cron },
            { jobId: j.id },
          ),
        );
        return this.toJob(j);
      },
    });
  }

  async update(
    id: string,
    dto: UpdateJobDto,
    principal: Principal,
  ): Promise<JobDto> {
    const current = await this.load(id);
    const runner = this.runnerFor(current.type, principal);
    const timezone = dto.timezone ?? current.timezone;
    const cron =
      dto.cron === undefined ? current.cron : dto.cron?.trim() || null;
    assertSchedule(cron, timezone);
    const params = dto.params ? await runner.validate(dto.params) : undefined;
    return this.bus.write({
      before: new BeforeWriteEvent(
        JOB_EVENTS.BEFORE_WRITE,
        'update',
        id,
        actorOf(principal),
        dto,
      ),
      work: async (tx, after) => {
        const j = await tx.job.update({
          where: { id },
          data: {
            name: dto.name,
            params: params as Prisma.InputJsonValue | undefined,
            cron,
            timezone,
            isActive: dto.isActive,
          },
        });
        const changes = diff(
          current as unknown as Record<string, unknown>,
          j as unknown as Record<string, unknown>,
          ['name', 'params', 'cron', 'timezone', 'isActive'],
        );
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent(
              JOB_EVENTS.UPDATED,
              actorOf(principal),
              'job',
              id,
              changes,
              { jobId: id },
            ),
          );
        return this.toJob(j);
      },
    });
  }

  async remove(id: string, principal: Principal): Promise<void> {
    const current = await this.load(id);
    this.runnerFor(current.type, principal);
    await this.bus.write({
      before: new BeforeWriteEvent(
        JOB_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(principal),
      ),
      work: async (tx, after) => {
        await tx.job.delete({ where: { id } });
        after.add(
          new EntityEvent(
            JOB_EVENTS.DELETED,
            actorOf(principal),
            'job',
            id,
            { code: current.code },
            { jobId: id },
          ),
        );
      },
    });
  }

  /** "Run now" for a defined job. */
  async run(id: string, principal: Principal): Promise<ExecutionDto> {
    const j = await this.load(id);
    this.runnerFor(j.type, principal);
    const e = await this.createExecution({
      jobId: j.id,
      type: j.type,
      params: j.params as Record<string, unknown>,
      trigger: 'MANUAL',
      actor: actorOf(principal),
    });
    await this.enqueue(e.id);
    return e;
  }

  /** A one-off run of a type (exports, reindexing, or an import with its uploaded file). */
  async start(
    dto: RunJobDto,
    principal: Principal,
    inputKey?: string,
  ): Promise<ExecutionDto> {
    const runner = this.runnerFor(dto.type, principal);
    if (runner.info.input && !inputKey)
      throw new BadRequestException(
        `${dto.type} needs an uploaded file; use POST /admin/imports`,
      );
    const params = await runner.validate(dto.params ?? {});
    const e = await this.createExecution({
      jobId: null,
      type: dto.type,
      params,
      trigger: 'MANUAL',
      actor: actorOf(principal),
      inputKey: inputKey ?? null,
    });
    await this.enqueue(e.id);
    return e;
  }

  /**
   * An import: the uploaded CSV is stored first, then its execution is queued (the file is removed
   * again if that fails).
   */
  async startImport(
    file: { buffer: Buffer; originalname?: string; size: number } | undefined,
    body: { type: string; params?: string },
    principal: Principal,
    maxBytes: number,
  ): Promise<ExecutionDto> {
    if (!file?.size)
      throw new BadRequestException('Attach the CSV file as "file"');
    if (file.size > maxBytes)
      throw new BadRequestException(
        `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    if (file.buffer.subarray(0, 8192).includes(0))
      throw new BadRequestException('The file is not a text (CSV) file');
    const runner = this.runnerFor(body.type, principal);
    if (runner.info.input !== 'csv')
      throw new BadRequestException(`${body.type} is not an import`);
    let params: Record<string, unknown> = {};
    if (body.params) {
      try {
        params = JSON.parse(body.params) as Record<string, unknown>;
      } catch {
        throw new BadRequestException('params must be a JSON object');
      }
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw new BadRequestException('params must be a JSON object');
    }
    const key = `job-inputs/${randomUUID()}/${safeName(file.originalname ?? 'import.csv')}`;
    await this.storage.putObject(
      key,
      file.buffer,
      'text/csv',
      'private, no-store',
    );
    try {
      return await this.start({ type: body.type, params }, principal, key);
    } catch (e) {
      await this.storage.deleteObjects([key]).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Records a queued execution. A defined job has at most one open run: a second request while it
   * is queued or running is refused (409).
   */
  async createExecution(input: {
    jobId: string | null;
    type: string;
    params: Record<string, unknown>;
    trigger: JobTrigger;
    actor: ActorRef;
    inputKey?: string | null;
  }): Promise<ExecutionDto> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        EXECUTION_EVENTS.BEFORE_WRITE,
        'queue',
        input.jobId,
        input.actor,
        { type: input.type, trigger: input.trigger },
      ),
      work: async (tx, after) => {
        const e = await tx.jobExecution.create({
          data: {
            jobId: input.jobId,
            type: input.type,
            params: input.params as Prisma.InputJsonValue,
            trigger: input.trigger,
            actorType: input.actor.type,
            actorId: input.actor.id,
            actorLabel: input.actor.label.slice(0, 255),
            inputKey: input.inputKey ?? null,
          },
          select: EXECUTION_SELECT,
        });
        if (input.jobId)
          await tx.job.update({
            where: { id: input.jobId },
            data: { lastRunAt: e.createdAt },
          });
        after.add(
          new EntityEvent<ExecutionEventData>(
            EXECUTION_EVENTS.QUEUED,
            input.actor,
            'job_execution',
            e.id,
            { type: e.type, trigger: e.trigger },
            {
              executionId: e.id,
              jobId: e.jobId,
              type: e.type,
              status: e.status,
            },
          ),
        );
        return toExecution(e);
      },
    });
  }

  /** Idempotent: the queue message id is the execution id. */
  async enqueue(executionId: string): Promise<void> {
    await this.queue.add(
      JOBS.JOB_EXECUTE,
      { executionId } satisfies JobExecuteJob,
      {
        jobId: executionId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async executions(
    q: ListExecutionsQueryDto,
  ): Promise<Paginated<ExecutionDto>> {
    const where: Prisma.JobExecutionWhereInput = {
      jobId: q.jobId,
      type: q.type,
      status: q.status,
    };
    const [rows, total] = await Promise.all([
      this.prisma.jobExecution.findMany({
        where,
        select: EXECUTION_SELECT,
        orderBy: [{ createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.jobExecution.count({ where }),
    ]);
    return paginated(rows.map(toExecution), total, q);
  }

  async execution(id: string): Promise<ExecutionDto> {
    const e = await this.prisma.jobExecution.findUnique({
      where: { id },
      select: EXECUTION_SELECT,
    });
    if (!e) throw new NotFoundException(`Execution ${id} not found`);
    return toExecution(e);
  }

  /** Queued runs stop at once; running ones stop at their next checkpoint. */
  async cancel(id: string, principal: Principal): Promise<ExecutionDto> {
    const e = await this.execution(id);
    this.runnerFor(e.type, principal);
    if (!['QUEUED', 'RUNNING'].includes(e.status))
      throw new ConflictException(
        `The execution has already ${e.status.toLowerCase()}`,
      );
    await this.bus.write({
      before: new BeforeWriteEvent(
        EXECUTION_EVENTS.BEFORE_WRITE,
        'cancel',
        id,
        actorOf(principal),
      ),
      work: async (tx, after) => {
        const queued = await tx.jobExecution.updateMany({
          where: { id, status: 'QUEUED' },
          data: {
            status: 'CANCELED',
            cancelRequested: true,
            finishedAt: new Date(),
          },
        });
        if (!queued.count)
          await tx.jobExecution.updateMany({
            where: { id, status: 'RUNNING' },
            data: { cancelRequested: true },
          });
        const data: ExecutionEventData = {
          executionId: id,
          jobId: e.jobId,
          type: e.type,
          status: queued.count ? 'CANCELED' : 'RUNNING',
        };
        after.add(
          new EntityEvent<ExecutionEventData>(
            EXECUTION_EVENTS.CANCEL_REQUESTED,
            actorOf(principal),
            'job_execution',
            id,
            { status: e.status },
            data,
          ),
        );
        // Not started yet: stopped now (a running one reports `canceled` when it stops).
        if (queued.count)
          after.add(new ProjectionEvent(EXECUTION_EVENTS.CANCELED, data));
      },
    });
    if (e.status === 'QUEUED')
      await this.queue.remove(id).catch(() => undefined);
    return this.execution(id);
  }

  /** A short-lived link to an export's file. */
  async download(id: string, principal: Principal): Promise<DownloadDto> {
    const e = await this.prisma.jobExecution.findUnique({
      where: { id },
      select: { type: true, outputKey: true, outputName: true },
    });
    if (!e) throw new NotFoundException(`Execution ${id} not found`);
    this.runnerFor(e.type, principal);
    if (!e.outputKey || !e.outputName)
      throw new NotFoundException(
        'This execution has no file (not finished, not an export, or expired)',
      );
    return {
      url: await this.storage.getSignedUrl(
        e.outputKey,
        DOWNLOAD_TTL_S,
        e.outputName,
      ),
      name: e.outputName,
    };
  }
}
