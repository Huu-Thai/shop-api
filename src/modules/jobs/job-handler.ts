import { BadRequestException } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { ActorRef, Principal } from '../../common/auth/principal.js';

/** What a job type is and who may run it (shown by `GET /admin/jobs/types`). */
export interface JobTypeInfo {
  /** Registry key, `<area>.<action>` (e.g. `export.orders`). */
  type: string;
  title: string;
  description: string;
  /** Permission needed (besides `jobs:write`) to run or schedule it. */
  permission: string;
  /** Imports run on an uploaded CSV file; they can't be scheduled. */
  input?: 'csv';
  /** Example parameters (documentation). */
  exampleParams?: Record<string, unknown>;
}

/** One problem with one input row (row numbers count the header as row 1). */
export interface RowError {
  row: number;
  message: string;
}

/** What a running handler can do: read its input, report progress, honour cancellation. */
export interface JobContext {
  readonly executionId: string;
  readonly params: Record<string, unknown>;
  /** Who started it (imports write as them; the audit log shows them). */
  readonly actor: ActorRef;
  /** The uploaded file (imports), read from storage. */
  input(): Promise<Buffer>;
  /** Progress as done / total (written at most every couple of seconds). */
  progress(done: number, total: number): Promise<void>;
  /** Records a row-level problem (the first 100 are kept). */
  rowError(row: number, message: string): void;
  /** True once someone asked to cancel; handlers check it between chunks and stop. */
  cancelRequested(): Promise<boolean>;
}

export interface JobOutcome {
  stats: Record<string, number>;
  /** A produced file (exports): stored and offered as a signed download. */
  output?: { name: string; contentType: string; body: Buffer };
}

/**
 * A job type. Implementations are providers marked with `@JobHandler()`; the registry discovers them
 * in every module, so the jobs module never depends on the domains whose work it runs.
 */
export interface JobRunner {
  readonly info: JobTypeInfo;
  /** Validates and normalises parameters (throw BadRequestException with a clear message). */
  validate(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  run(ctx: JobContext): Promise<JobOutcome>;
}

/** Marks a provider as a job type (see JobRunner). */
export const JobHandler = DiscoveryService.createDecorator<void>();

/**
 * The starter as a principal, for services that take one (their writes are audited under that
 * admin or API key). Scheduled runs have no human starter, so writing handlers can't be scheduled.
 */
export function principalOf(ctx: JobContext, permission: string): Principal {
  if (ctx.actor.type !== 'admin' && ctx.actor.type !== 'api-key')
    throw new Error(
      'This job writes data and must be started by an admin or an API key',
    );
  return {
    type: ctx.actor.type,
    id: ctx.actor.id!,
    label: ctx.actor.label,
    permissions: [permission],
  };
}

/** Thrown by handlers that noticed a cancellation request. */
export class JobCanceledError extends Error {
  constructor() {
    super('Canceled');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parameter helpers for handlers' `validate`. */
export const params = {
  /** Only these keys are accepted. */
  only(p: Record<string, unknown>, keys: readonly string[]): void {
    const extra = Object.keys(p).filter((k) => !keys.includes(k));
    if (extra.length)
      throw new BadRequestException(
        `Unknown parameter(s): ${extra.join(', ')}${keys.length ? ` (allowed: ${keys.join(', ')})` : ' (this job takes none)'}`,
      );
  },
  uuids(p: Record<string, unknown>, key: string): string[] | undefined {
    const v = p[key];
    if (v === undefined) return undefined;
    if (
      !Array.isArray(v) ||
      !v.every((x) => typeof x === 'string' && UUID.test(x))
    )
      throw new BadRequestException(`${key} must be a list of ids`);
    return v as string[];
  },
  string(
    p: Record<string, unknown>,
    key: string,
    opts: { required?: boolean; max?: number; pattern?: RegExp } = {},
  ): string | undefined {
    const v = p[key];
    if (v === undefined || v === null || v === '') {
      if (opts.required) throw new BadRequestException(`${key} is required`);
      return undefined;
    }
    if (
      typeof v !== 'string' ||
      v.length > (opts.max ?? 255) ||
      (opts.pattern && !opts.pattern.test(v))
    )
      throw new BadRequestException(`${key} is not valid`);
    return v;
  },
  oneOf<T extends string>(
    p: Record<string, unknown>,
    key: string,
    values: readonly T[],
    fallback: T,
  ): T {
    const v = p[key] ?? fallback;
    if (!values.includes(v as T))
      throw new BadRequestException(
        `${key} must be one of ${values.join(', ')}`,
      );
    return v as T;
  },
  date(p: Record<string, unknown>, key: string): string | undefined {
    const v = p[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v)))
      throw new BadRequestException(`${key} must be an ISO date`);
    return new Date(v).toISOString();
  },
};
