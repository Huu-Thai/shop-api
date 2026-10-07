import { ExportAuditLogJob } from './audit/audit.jobs.js';
import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys/api-keys.controller.js';
import { ApiKeysService } from './api-keys/api-keys.service.js';
import { AuditLogsController } from './audit/audit-logs.controller.js';
import { AuditLogsService } from './audit/audit-logs.service.js';
import { AuditListener } from './audit/audit.listener.js';
import { AuthCacheListener } from './audit/auth-cache.listener.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionService } from './auth/session.service.js';
import { RolesController } from './roles/roles.controller.js';
import { RolesService } from './roles/roles.service.js';
import { AdminUsersController } from './users/admin-users.controller.js';
import { AdminUsersService } from './users/admin-users.service.js';

/** Back-office identity: sign-in, admin users, roles/permissions, API keys and the audit log. */
@Module({
  controllers: [
    AuthController,
    AdminUsersController,
    RolesController,
    ApiKeysController,
    AuditLogsController,
  ],
  providers: [
    AuthService,
    SessionService,
    AdminUsersService,
    RolesService,
    ApiKeysService,
    AuditLogsService,
    AuthCacheListener,
  ],
  exports: [AdminUsersService],
})
export class AdminModule {}

/** Audit recording runs in every process (events are emitted by API and worker alike). */
@Module({ providers: [AuditListener, ExportAuditLogJob] })
export class AuditRecorderModule {}
