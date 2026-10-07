import { entityEvents } from '../../common/events/entity.events.js';

export const JOB_EVENTS = entityEvents('job');

export const EXECUTION_EVENTS = {
  BEFORE_WRITE: 'job-execution.before-write',
  /** Queued by someone (audited); scheduled runs are queued by the system. */
  QUEUED: 'job-execution.queued',
  /** Someone asked to cancel (audited); `canceled` follows once it has stopped. */
  CANCEL_REQUESTED: 'job-execution.cancel-requested',
  CANCELED: 'job-execution.canceled',
  SUCCEEDED: 'job-execution.succeeded',
  FAILED: 'job-execution.failed',
} as const;

export interface ExecutionEventData {
  executionId: string;
  jobId: string | null;
  type: string;
  status: string;
  stats?: Record<string, number>;
  error?: string | null;
}
