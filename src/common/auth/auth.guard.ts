import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_HEADER } from '../constants/api.constants.js';
import {
  ADMIN_ONLY_KEY,
  AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators/auth.decorators.js';
import { hasPermission } from './permissions.js';
import type { AuthenticatedRequest } from './principal.js';
import { PrincipalResolver } from './principal.resolver.js';

/**
 * Global guard, deny-by-default: a route must be @Public, @Authenticated or
 * @RequirePermissions(...). Credentials: `Authorization: Bearer <admin JWT>` or `x-api-key`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const meta = <T>(key: string) =>
      this.reflector.getAllAndOverride<T>(key, targets);
    if (meta<boolean>(IS_PUBLIC_KEY)) return true;

    const required = meta<string[]>(PERMISSIONS_KEY);
    const authenticatedOnly = meta<boolean>(AUTHENTICATED_KEY);
    if (!required && !authenticatedOnly) {
      const name = `${context.getClass().name}.${context.getHandler().name}`;
      this.logger.error(
        `Route ${name} declares no auth policy — denied (add @Public, @Authenticated or @RequirePermissions)`,
      );
      throw new ForbiddenException('This route is not available');
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const bearer = /^Bearer\s+(\S+)$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    const apiKey = request.headers[API_KEY_HEADER];
    if (bearer) request.principal = await this.resolver.fromAccessToken(bearer);
    else if (typeof apiKey === 'string' && apiKey)
      request.principal = await this.resolver.fromApiKey(apiKey);
    else throw new UnauthorizedException('Authentication required');

    if (meta<boolean>(ADMIN_ONLY_KEY) && request.principal.type !== 'admin')
      throw new ForbiddenException('Only admin users can do this');
    const missing = (required ?? []).filter(
      (p) => !hasPermission(request.principal!.permissions, p),
    );
    if (missing.length)
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
