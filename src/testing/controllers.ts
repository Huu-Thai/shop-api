import { vi } from 'vitest';

/** A service double whose every method is a vi.fn resolving to `result` ('ok' when omitted). */
export function stubService(...args: [result?: unknown]) {
  const result = args.length ? args[0] : 'ok';
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      if (!fns.has(prop))
        fns.set(
          prop,
          vi.fn(async () => result),
        );
      return fns.get(prop);
    },
  });
}

/** Any argument: every property reads as 'x'. */
export const ANY: Record<string, string> = new Proxy(
  {},
  { get: (_t, p) => (p === 'then' ? undefined : 'x') },
);

/**
 * Calls every handler of a controller with placeholder arguments; returns how many calls
 * resolved and how many threw (e.g. 404 when the stub returns nothing).
 */
export async function exerciseController(
  ctrl: object,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const proto = Object.getPrototypeOf(ctrl) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || typeof proto[name] !== 'function') continue;
    try {
      await (proto[name] as (...a: unknown[]) => unknown).call(
        ctrl,
        ANY,
        ANY,
        ANY,
      );
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}
