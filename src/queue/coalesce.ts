import type { Redis } from 'ioredis';

/**
 * Coalescing for "rebuild everything" jobs. Every request bumps a generation counter and enqueues
 * a job carrying it; a job whose generation was superseded by a later request skips itself (the
 * later job will do the work). A burst collapses into one run, and a change that arrives while a
 * rebuild is running always gets its own run afterwards — unlike jobId de-duplication, which drops
 * requests while a job with that id is active or still kept as completed.
 */
export async function nextGeneration(
  redis: Redis,
  key: string,
): Promise<number> {
  return redis.incr(key);
}

export async function isSuperseded(
  redis: Redis,
  key: string,
  generation: number | undefined,
): Promise<boolean> {
  if (generation === undefined) return false;
  const current = Number((await redis.get(key)) ?? 0);
  return generation < current;
}

/** Delay before a coalesced job starts, so a burst of requests ends up as one run. */
export const COALESCE_DELAY_MS = 1_000;
