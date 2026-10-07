/**
 * Bootstrap / break-glass: create a super-admin (or reset its password) from the command line.
 *   ADMIN_EMAIL=ops@shop.local ADMIN_PASSWORD='…' npm run admin:create
 * Runs through the normal write path (transaction, events, audit log) as the `system` actor.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword, passwordProblems } from '../common/auth/password.js';
import { SYSTEM_ACTOR } from '../common/auth/principal.js';
import { TransactionalEventBus } from '../common/events/transactional-event-bus.js';
import { PrismaService } from '../database/prisma.service.js';
import { SUPER_ADMIN } from '../modules/admin/users/admin-users.service.js';
import {
  AdminUserBeforeWriteEvent,
  AdminUserCreatedEvent,
  AdminUserPasswordChangedEvent,
} from '../modules/admin/users/events/admin-user.events.js';
import { CliModule } from './cli.module.js';

try {
  process.loadEnvFile();
} catch {
  // environment from the shell / container
}

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const log = new Logger('create-admin');

if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
  log.error('Set ADMIN_EMAIL to a valid e-mail address');
  process.exit(2);
}
const problems = passwordProblems(password, email);
if (problems.length) {
  log.error(`ADMIN_PASSWORD ${problems.join('; ')}`);
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(CliModule, {
  logger: ['error', 'warn', 'log'],
});
try {
  const prisma = app.get(PrismaService);
  const bus = app.get(TransactionalEventBus);
  const role = await prisma.role.findUniqueOrThrow({
    where: { code: SUPER_ADMIN },
    select: { id: true },
  });
  const passwordHash = await hashPassword(password);
  const existing = await prisma.adminUser.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  });
  const result = await bus.write({
    before: new AdminUserBeforeWriteEvent(
      existing ? 'password' : 'create',
      existing?.id ?? null,
      SYSTEM_ACTOR,
    ),
    work: async (tx, after) => {
      if (existing) {
        await tx.adminUser.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            passwordChangedAt: new Date(),
            status: 'ACTIVE',
            failedLogins: 0,
            lockedUntil: null,
          },
        });
        await tx.adminUserRole.upsert({
          where: {
            adminUserId_roleId: { adminUserId: existing.id, roleId: role.id },
          },
          create: { adminUserId: existing.id, roleId: role.id },
          update: {},
        });
        after.add(
          new AdminUserPasswordChangedEvent(SYSTEM_ACTOR, existing.id, 'admin'),
        );
        return 'updated';
      }
      const u = await tx.adminUser.create({
        data: { email, passwordHash, roles: { create: [{ roleId: role.id }] } },
        select: { id: true },
      });
      after.add(
        new AdminUserCreatedEvent(SYSTEM_ACTOR, u.id, email, [SUPER_ADMIN]),
      );
      return 'created';
    },
  });
  log.log(`Super-admin ${email} ${result}`);
} finally {
  await app.close();
}
