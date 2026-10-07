import { createHash, timingSafeEqual } from 'node:crypto';

/** `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time; open when no token is set. */
export function metricsAuthorized(
  token: string | undefined,
  authorization: string | undefined,
): boolean {
  if (!token) return true;
  const given = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1] ?? '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}
