import { Throttle } from '@nestjs/throttler';

/** Brute-force budget for login / refresh: THROTTLE_AUTH_LIMIT per THROTTLE_TTL_MS per client IP. */
export const AuthThrottle = () =>
  Throttle({
    default: {
      limit: () => Number(process.env.THROTTLE_AUTH_LIMIT ?? 10),
      ttl: () => Number(process.env.THROTTLE_TTL_MS ?? 60_000),
    },
  });
