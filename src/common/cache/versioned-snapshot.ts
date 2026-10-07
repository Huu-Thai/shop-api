import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * An in-process copy of rarely changing reference data, shared correctly across processes: a
 * Redis counter is bumped on change (`invalidate`) and checked at most every `checkMs`; the copy is
 * reloaded when the counter moved or it is older than `maxAgeMs`. Concurrent reloads share one load.
 */
export class VersionedSnapshot<T> {
  private readonly logger = new Logger(VersionedSnapshot.name);
  private cached?: {
    value: T;
    version: string | null;
    loadedAt: number;
    checkedAt: number;
  };
  private loading?: Promise<T>;

  constructor(
    private readonly redis: Redis,
    private readonly versionKey: string,
    private readonly load: () => Promise<T>,
    private readonly checkMs = 5_000,
    private readonly maxAgeMs = 60_000,
  ) {}

  /**
   * `fresh` bypasses the cache and reloads now — for background jobs, which must not act on a
   * copy that may be up to `checkMs` behind the change that triggered them.
   */
  async get(fresh = false): Promise<T> {
    if (fresh) {
      const version = await this.redis.get(this.versionKey).catch(() => null);
      const value = await this.load();
      this.cached = {
        value,
        version,
        loadedAt: Date.now(),
        checkedAt: Date.now(),
      };
      return value;
    }
    const now = Date.now();
    const c = this.cached;
    if (
      c &&
      now - c.checkedAt < this.checkMs &&
      now - c.loadedAt < this.maxAgeMs
    )
      return c.value;
    const version = await this.redis
      .get(this.versionKey)
      .catch(() => c?.version ?? null);
    if (c && version === c.version && now - c.loadedAt < this.maxAgeMs) {
      c.checkedAt = now;
      return c.value;
    }
    this.loading ??= this.load()
      .then((value) => {
        this.cached = {
          value,
          version,
          loadedAt: Date.now(),
          checkedAt: Date.now(),
        };
        return value;
      })
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  async invalidate(): Promise<void> {
    this.cached = undefined;
    await this.redis
      .incr(this.versionKey)
      .catch((e: Error) =>
        this.logger.warn(`Could not bump ${this.versionKey}: ${e.message}`),
      );
  }
}
