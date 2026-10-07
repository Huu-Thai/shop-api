import type { Job } from 'bullmq';
import { requestContext } from '../../logger/request-context.js';
import { timeJob } from '../../metrics/metrics.js';

/** Runs a processor body with jobId / queue on every log line it produces, and times it. */
export function withJobContext<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ jobId: job.id, queue: job.queueName }, () =>
    timeJob(job.queueName, job.name, fn),
  );
}
