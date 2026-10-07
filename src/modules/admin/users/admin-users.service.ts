import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hashPassword,
  passwordProblems,
} from '../../../common/auth/password.js';
import { actorOf, type Principal } from '../../../common/auth/principal.js';
import {
  paginated,
  type Paginated,
} from '../../../common/dto/pagination.dto.js';
import { diff } from '../../../common/events/audited.event.js';
import { TransactionalEventBus } from '../../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../../database/prisma.service.js';
import { SessionService } from '../auth/session.service.js';
import { assertGrantable } from '../roles/grant.js';
import type {
  AdminUserDto,
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  UpdateAdminUserDto,
} from './dto/admin-user.dto.js';
import {
  AdminUserBeforeWriteEvent,
  AdminUserCreatedEvent,
  AdminUserDeletedEvent,
  AdminUserPasswordChangedEvent,
  AdminUserUpdatedEvent,
} from './events/admin-user.events.js';

export const SUPER_ADMIN = 'super-admin';

const SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { id: true, code: true, name: true } } } },
} as const;
type Row = Prisma.AdminUserGetPayload<{ select: typeof SELECT }>;

const toDto = (u: Row): AdminUserDto => ({
  ...u,
  roles: u.roles.map((r) => r.role),
});

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly sessions: SessionService,
  ) {}

  async list(q: ListAdminUsersQueryDto): Promise<Paginated<AdminUserDto>> {
    const where: Prisma.AdminUserWhereInput = {
      deletedAt: null,
      status: q.status,
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search, mode: 'insensitive' } },
              { firstName: { contains: q.search, mode: 'insensitive' } },
              { lastName: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminUser.findMany({
        where,
        select: SELECT,
        orderBy: { createdAt: q.order },
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.adminUser.count({ where }),
    ]);
    return paginated(rows.map(toDto), total, q);
  }

  async get(id: string): Promise<AdminUserDto> {
    const row = await this.prisma.adminUser.findFirst({
      where: { id, deletedAt: null },
      select: SELECT,
    });
    if (!row) throw new NotFoundException(`Admin user ${id} not found`);
    return toDto(row);
  }

  /** Roles to assign: must exist, and the actor must hold every permission they carry. */
  private async checkRoles(
    tx: PrismaTransaction | PrismaService,
    actor: Principal,
    roleIds: string[],
  ) {
    const ids = [...new Set(roleIds)];
    const roles = await tx.role.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        permissions: { select: { permission: true } },
      },
    });
    if (roles.length !== ids.length)
      throw new BadRequestException('One or more roleIds do not exist');
    assertGrantable(
      actor,
      roles.flatMap((r) => r.permissions.map((p) => p.permission)),
    );
    return roles;
  }

  async create(
    dto: CreateAdminUserDto,
    actor: Principal,
  ): Promise<AdminUserDto> {
    const problems = passwordProblems(dto.password, dto.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `password ${p}`));
    await this.checkRoles(this.prisma, actor, dto.roleIds);
    const passwordHash = await hashPassword(dto.password);
    const row = await this.bus.write({
      before: new AdminUserBeforeWriteEvent('create', null, actorOf(actor)),
      work: async (tx, after) => {
        const roles = await this.checkRoles(tx, actor, dto.roleIds);
        const u = await tx.adminUser.create({
          data: {
            email: dto.email,
            passwordHash,
            firstName: dto.firstName ?? null,
            lastName: dto.lastName ?? null,
            roles: { create: roles.map((r) => ({ roleId: r.id })) },
          },
          select: SELECT,
        });
        after.add(
          new AdminUserCreatedEvent(
            actorOf(actor),
            u.id,
            u.email,
            roles.map((r) => r.code),
          ),
        );
        return u;
      },
    });
    return toDto(row);
  }

  async update(
    id: string,
    dto: UpdateAdminUserDto,
    actor: Principal,
  ): Promise<AdminUserDto> {
    if (id === actor.id && (dto.status === 'DISABLED' || dto.roleIds))
      throw new ForbiddenException(
        'You cannot disable yourself or change your own roles',
      );
    const { row, families } = await this.bus.write({
      before: new AdminUserBeforeWriteEvent('update', id, actorOf(actor)),
      work: async (tx, after) => {
        const before = await tx.adminUser.findFirst({
          where: { id, deletedAt: null },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Admin user ${id} not found`);
        // Roles being removed must also be within the actor's power (can't strip a super-admin otherwise).
        const currentRoleIds = before.roles.map((r) => r.role.id);
        if (dto.roleIds)
          await this.checkRoles(tx, actor, [
            ...new Set([...dto.roleIds, ...currentRoleIds]),
          ]);
        const u = await tx.adminUser.update({
          where: { id },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            status: dto.status,
            ...(dto.status === 'ACTIVE'
              ? { lockedUntil: null, failedLogins: 0 }
              : {}),
            ...(dto.roleIds
              ? {
                  roles: {
                    deleteMany: {},
                    create: [...new Set(dto.roleIds)].map((roleId) => ({
                      roleId,
                    })),
                  },
                }
              : {}),
          },
          select: SELECT,
        });
        await this.assertSuperAdminRemains(tx);
        const f =
          dto.status === 'DISABLED'
            ? await this.sessions.revokeFamilies(tx, { adminUserId: id })
            : [];
        const changes = diff(
          { ...before, roles: before.roles.map((r) => r.role.code).sort() },
          { ...u, roles: u.roles.map((r) => r.role.code).sort() },
          ['firstName', 'lastName', 'status', 'roles'],
        );
        if (Object.keys(changes).length)
          after.add(new AdminUserUpdatedEvent(actorOf(actor), id, changes));
        return { row: u, families: f };
      },
    });
    await this.sessions.markRevoked(families);
    return toDto(row);
  }

  async resetPassword(
    id: string,
    newPassword: string,
    actor: Principal,
  ): Promise<void> {
    const user = await this.get(id);
    const problems = passwordProblems(newPassword, user.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `newPassword ${p}`));
    const passwordHash = await hashPassword(newPassword);
    const families = await this.bus.write({
      before: new AdminUserBeforeWriteEvent('password', id, actorOf(actor)),
      work: async (tx, after) => {
        await tx.adminUser.update({
          where: { id },
          data: {
            passwordHash,
            passwordChangedAt: new Date(),
            failedLogins: 0,
            lockedUntil: null,
          },
        });
        const f = await this.sessions.revokeFamilies(tx, { adminUserId: id });
        after.add(
          new AdminUserPasswordChangedEvent(
            actorOf(actor),
            id,
            id === actor.id ? 'self' : 'admin',
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked(families);
  }

  /** Soft delete: the e-mail is freed (renamed) so it can be reused, history is kept. */
  async remove(id: string, actor: Principal): Promise<void> {
    if (id === actor.id)
      throw new ForbiddenException('You cannot delete yourself');
    const families = await this.bus.write({
      before: new AdminUserBeforeWriteEvent('delete', id, actorOf(actor)),
      work: async (tx, after) => {
        const u = await tx.adminUser.findFirst({
          where: { id, deletedAt: null },
          select: SELECT,
        });
        if (!u) throw new NotFoundException(`Admin user ${id} not found`);
        await this.checkRoles(
          tx,
          actor,
          u.roles.map((r) => r.role.id),
        );
        await tx.adminUser.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            status: 'DISABLED',
            email: `deleted+${id}@invalid`,
            roles: { deleteMany: {} },
          },
        });
        await this.assertSuperAdminRemains(tx);
        const f = await this.sessions.revokeFamilies(tx, { adminUserId: id });
        after.add(new AdminUserDeletedEvent(actorOf(actor), id, u.email));
        return f;
      },
    });
    await this.sessions.markRevoked(families);
  }

  /** At least one active, non-deleted super-admin must exist after any change. */
  private async assertSuperAdminRemains(tx: PrismaTransaction): Promise<void> {
    const count = await tx.adminUser.count({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { code: SUPER_ADMIN } } },
      },
    });
    if (!count)
      throw new ConflictException('This would leave no active super-admin');
  }
}
