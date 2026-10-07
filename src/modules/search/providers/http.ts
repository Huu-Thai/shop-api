import type { SearchConnection } from '../search.types.js';

export class SearchEngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HttpOptions {
  method?: string;
  body?: unknown;
  /** Raw body (NDJSON for bulk APIs). */
  raw?: string;
  contentType?: string;
  /** Statuses that are not errors (e.g. 404 when deleting a missing index). */
  ok?: number[];
  timeoutMs?: number;
}

/** Minimal JSON-over-HTTP client for search engines; errors never include credentials. */
export class EngineHttp {
  constructor(
    private readonly conn: SearchConnection,
    private readonly authHeader: (
      c: SearchConnection,
    ) => Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(path: string, o: HttpOptions = {}): Promise<T> {
    const url = `${this.conn.url.replace(/\/+$/, '')}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method:
          o.method ??
          (o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET'),
        headers: {
          ...(o.body !== undefined || o.raw !== undefined
            ? { 'content-type': o.contentType ?? 'application/json' }
            : {}),
          ...this.authHeader(this.conn),
        },
        body:
          o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new SearchEngineError(
        `Search engine unreachable at ${new URL(url).origin}: ${(e as Error).message}`,
      );
    }
    const text = await res.text();
    if (!res.ok && !o.ok?.includes(res.status))
      throw new SearchEngineError(
        `Search engine ${o.method ?? 'request'} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** JSON string literal for filter expressions (Meilisearch). */
export const quote = (v: string) => JSON.stringify(v);
