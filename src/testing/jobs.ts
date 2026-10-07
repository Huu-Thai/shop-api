import type { JobContext, RowError } from '../modules/jobs/job-handler.js';

/** A JobContext double: records progress and row errors; the input is the given CSV text. */
export function jobContext(
  input = '',
  extra: Partial<JobContext> = {},
): JobContext & { errors: RowError[]; progressCalls: [number, number][] } {
  const errors: RowError[] = [];
  const progressCalls: [number, number][] = [];
  return {
    executionId: 'e1',
    params: {},
    actor: {
      type: 'admin',
      id: '00000000-0000-4000-8000-000000000001',
      label: 'root@shop.test',
    },
    input: vi.fn(async () => Buffer.from(input, 'utf8')),
    progress: vi.fn(async (done: number, total: number) => {
      progressCalls.push([done, total]);
    }),
    rowError: (row, message) => errors.push({ row, message }),
    cancelRequested: vi.fn(async () => false),
    errors,
    progressCalls,
    ...extra,
  };
}

/** The produced CSV without its BOM. */
export const outputText = (o: { output?: { body: Buffer } }) =>
  o.output!.body.toString('utf8').replace(/^﻿/, '');
