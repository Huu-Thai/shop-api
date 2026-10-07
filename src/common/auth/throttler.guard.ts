import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from './principal.js';

/** Rate limits per principal (admin or API key), per client IP for anonymous calls. */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const p = (req as unknown as AuthenticatedRequest).principal;
    return Promise.resolve(
      p ? `${p.type}:${p.id}` : `ip:${String(req.ip ?? 'unknown')}`,
    );
  }
}
