import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { canGrant, isGrantable } from '../../../common/auth/permissions.js';
import type { Principal } from '../../../common/auth/principal.js';

/** Valid catalogue entries only, and nothing the actor doesn't hold (no privilege escalation). */
export function assertGrantable(
  actor: Principal,
  permissions: string[],
): string[] {
  const unique = [...new Set(permissions.map((p) => p.trim()))];
  const unknown = unique.filter((p) => !isGrantable(p));
  if (unknown.length)
    throw new BadRequestException(
      `Unknown permission(s): ${unknown.join(', ')} — see GET /admin/permissions`,
    );
  const beyond = unique.filter((p) => !canGrant(actor.permissions, p));
  if (beyond.length)
    throw new ForbiddenException(
      `You cannot grant permissions you don't hold: ${beyond.join(', ')}`,
    );
  return unique;
}
