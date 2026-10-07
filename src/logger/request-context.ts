import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields attached to every log line emitted while handling a request or job. */
export interface RequestContext {
  requestId?: string;
  jobId?: string;
  queue?: string;
  /** Client IP of the HTTP request (for the audit log). */
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run({ ...context }, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Adds fields to the current context. */
  set(patch: Partial<RequestContext>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
