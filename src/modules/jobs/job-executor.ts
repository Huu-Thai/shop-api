import { jobExecutions } from '../../metrics/metrics.js';
import { Injectable, Logger } from '@nestjs/common';
import { type ActorRef, SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  JobCanceledError,
  type JobContext,
  type JobOutcome,
  type RowError,
} from './job-handler.js';
import { JobRegistry } from './job-registry.js';
import { EXECUTION_EVENTS, type ExecutionEventData } from './jobs.events.js';

const MAX_ROW_ERRORS = 100;
/** Progress and cancellation are written / read at most this often. */
const CHECK_EVERY_MS = 2_000;

type Final = 'SUCCEEDED' | 'FAILED' | 'CANCELED';

/** Storage key of an execution's files. */
export const executionFileKey = (executionId: string, name: string) =>
  `job-executions/${executionId}/${name}`;

/**
 * Runs one execution: claims it (QUEUED → RUNNING, so it runs once), gives the handler a context for
 * progress, row errors and cancellation, stores what it produced and records the outcome.
 */
@Injectable()
export class JobExecutor {
  private readonly logger = new Logger(JobExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly registry: JobRegistry,
    private readonly storage: StorageService,
  ) {}

  private before(action: string, id: string) {
    return new BeforeWriteEvent(
      EXECUTION_EVENTS.BEFORE_WRITE,
      action,
      id,
      SYSTEM_ACTOR,
    );
  }

  async execute(
    executionId: string,
    now = () => Date.now(),
  ): Promise<Final | 'SKIPPED'> {
    const claimed = await this.bus.write({
      before: this.before('start', executionId),
      work: (tx) =>
        tx.jobExecution.updateMany({
          where: { id: executionId, status: 'QUEUED' },
          data: { status: 'RUNNING', startedAt: new Date() },
        }),
    });
    const e = await this.prisma.jobExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        jobId: true,
        type: true,
        status: true,
        params: true,
        inputKey: true,
        actorType: true,
        actorId: true,
        actorLabel: true,
      },
    });
    if (!e) return 'SKIPPED';
    if (!claimed.count) {
      // Delivered again while marked running: the worker that had it stopped (crash, deploy).
      if (e.status === 'RUNNING') {
        await this.finish(e, 'FAILED', {
          error:
            'The worker running it stopped before it finished; run it again (imports are safe to repeat)',
        });
        return 'FAILED';
      }
      return 'SKIPPED'; // canceled while queued, or already done
    }

    const errors: RowError[] = [];
    let failedRows = 0;
    let lastProgress = -Infinity;
    let lastCancelCheck = -Infinity;
    let canceled = false;
    const ctx: JobContext = {
      executionId,
      params: e.params as Record<string, unknown>,
      actor: {
        type: e.actorType as ActorRef['type'],
        id: e.actorId,
        label: e.actorLabel,
      },
      input: async () => {
        if (!e.inputKey) throw new Error('This execution has no input file');
        return this.storage.getObject(e.inputKey);
      },
      progress: async (done, total) => {
        if (now() - lastProgress < CHECK_EVERY_MS && done < total) return;
        lastProgress = now();
        const progress =
          total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0;
        await this.bus.write({
          before: this.before('progress', executionId),
          work: (tx) =>
            tx.jobExecution.updateMany({
              where: { id: executionId, status: 'RUNNING' },
              data: { progress },
            }),
        });
      },
      rowError: (row, message) => {
        failedRows++;
        if (errors.length < MAX_ROW_ERRORS)
          errors.push({ row, message: message.slice(0, 500) });
      },
      cancelRequested: async () => {
        if (canceled) return true;
        if (now() - lastCancelCheck < CHECK_EVERY_MS) return false;
        lastCancelCheck = now();
        const r = await this.prisma.jobExecution.findUnique({
          where: { id: executionId },
          select: { cancelRequested: true },
        });
        canceled = !!r?.cancelRequested;
        return canceled;
      },
    };

    let outcome: JobOutcome;
    try {
      outcome = await this.registry.get(e.type).run(ctx);
    } catch (err) {
      if (err instanceof JobCanceledError || canceled) {
        await this.finish(e, 'CANCELED', { errors });
        return 'CANCELED';
      }
      this.logger.error(
        `Execution ${executionId} (${e.type}) failed: ${(err as Error).message}`,
      );
      await this.finish(e, 'FAILED', {
        errors,
        error: (err as Error).message,
      });
      return 'FAILED';
    }

    let output: { key: string; name: string } | undefined;
    if (outcome.output) {
      const key = executionFileKey(executionId, outcome.output.name);
      await this.storage.putObject(
        key,
        outcome.output.body,
        outcome.output.contentType,
        'private, no-store',
      );
      output = { key, name: outcome.output.name };
    }
    const stats = { ...outcome.stats };
    if (failedRows && stats.failed === undefined) stats.failed = failedRows;
    await this.finish(e, 'SUCCEEDED', { stats, errors, output });
    return 'SUCCEEDED';
  }

  /** A running execution whose queue message is gone (the worker died for good). */
  async abandon(executionId: string): Promise<void> {
    const e = await this.prisma.jobExecution.findUnique({
      where: { id: executionId },
      select: { id: true, jobId: true, type: true, status: true },
    });
    if (e?.status !== 'RUNNING') return;
    await this.finish(e, 'FAILED', {
      error:
        'The worker running it stopped before it finished; run it again (imports are safe to repeat)',
    });
  }

  private async finish(
    e: { id: string; jobId: string | null; type: string },
    status: Final,
    extra: {
      stats?: Record<string, number>;
      errors?: RowError[];
      error?: string;
      output?: { key: string; name: string };
    },
  ): Promise<void> {
    jobExecutions.inc({ type: e.type, status });
    await this.bus.write({
      before: this.before(status.toLowerCase(), e.id),
      work: async (tx, after) => {
        await tx.jobExecution.update({
          where: { id: e.id },
          data: {
            status,
            finishedAt: new Date(),
            ...(status === 'SUCCEEDED' ? { progress: 100 } : {}),
            ...(extra.stats ? { stats: extra.stats } : {}),
            ...(extra.errors
              ? { errors: extra.errors as unknown as Prisma.InputJsonValue }
              : {}),
            error: extra.error?.slice(0, 2000) ?? null,
            ...(extra.output
              ? { outputKey: extra.output.key, outputName: extra.output.name }
              : {}),
          },
        });
        after.add(
          new ProjectionEvent<ExecutionEventData>(
            status === 'SUCCEEDED'
              ? EXECUTION_EVENTS.SUCCEEDED
              : status === 'FAILED'
                ? EXECUTION_EVENTS.FAILED
                : EXECUTION_EVENTS.CANCELED,
            {
              executionId: e.id,
              jobId: e.jobId,
              type: e.type,
              status,
              stats: extra.stats,
              error: extra.error ?? null,
            },
          ),
        );
      },
    });
  }
}
