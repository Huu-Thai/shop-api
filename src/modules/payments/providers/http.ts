import { ProviderError } from './types.js';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Statuses that return the body instead of throwing. */
  ok?: number[];
}

/** A small fetch wrapper for provider APIs: JSON or form bodies, timeout, errors with the provider's message. */
export async function providerRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  opts: HttpOptions = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new ProviderError(
      `Payment provider unreachable: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON body (kept as text)
  }
  if (!res.ok && !(opts.ok ?? []).includes(res.status)) {
    const p = parsed as {
      error?: { message?: string } | string;
      message?: string;
    };
    const msg =
      (typeof p?.error === 'object' ? p.error?.message : p?.error) ??
      p?.message ??
      text.slice(0, 200);
    throw new ProviderError(`Payment provider error ${res.status}: ${msg}`);
  }
  return { status: res.status, body: parsed as T };
}
