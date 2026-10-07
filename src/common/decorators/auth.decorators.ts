import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import type { Permission } from '../auth/permissions.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const AUTHENTICATED_KEY = 'auth:authenticated';
export const PERMISSIONS_KEY = 'auth:permissions';
export const ADMIN_ONLY_KEY = 'auth:adminOnly';

/** No authentication (health, login, storefront reads). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

const docs = () =>
  applyDecorators(
    ApiBearerAuth('admin-jwt'),
    ApiSecurity('api-key'),
    ApiUnauthorizedResponse(),
    ApiForbiddenResponse(),
  );

/** Any authenticated principal, no specific permission (e.g. GET /admin/auth/me). */
export const Authenticated = () =>
  applyDecorators(SetMetadata(AUTHENTICATED_KEY, true), docs());

/** Every listed permission is required. Routes without an auth decorator are denied. */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(SetMetadata(PERMISSIONS_KEY, permissions), docs());

/** Only admin users (not API keys) — e.g. managing other admins' sessions. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);
