import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PERMISSIONS } from '../../../common/auth/permissions.js';
import { actorOf, type Principal } from '../../../common/auth/principal.js';
import { diff } from '../../../common/events/audited.event.js';
import { TransactionalEventBus } from '../../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  CreateRoleDto,
  PermissionDto,
  RoleDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import {
  RoleBeforeWriteEvent,
  RoleCreatedEvent,
  RoleDeletedEvent,
  RoleUpdatedEvent,
} from './events/role.events.js';
import { assertGrantable } from './grant.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permission: true }, orderBy: { permission: 'asc' } },
  _count: { select: { users: true } },
} as const satisfies Prisma.RoleSelect;
type Row = Prisma.RoleGetPayload<{ select: typeof SELECT }>;

const toDto = ({ permissions, _count, ...r }: Row): RoleDto => ({
  ...r,
  permissions: permissions.map((p) => p.permission),
  userCount: _count.users,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  permissions(): PermissionDto[] {
    return Object.entries(PERMISSIONS).map(([key, description]) => ({
      key,
      area: key.split(':')[0],
      description,
    }));
  }

  async list(): Promise<RoleDto[]> {
    return (
      await this.prisma.role.findMany({
        select: SELECT,
        orderBy: { name: 'asc' },
      })
    ).map(toDto);
  }

  async get(id: string): Promise<RoleDto> {
    const row = await this.prisma.role.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!row) throw new NotFoundException(`Role ${id} not found`);
    return toDto(row);
  }

  async create(dto: CreateRoleDto, actor: Principal): Promise<RoleDto> {
    const permissions = assertGrantable(actor, dto.permissions);
    const row = await this.bus.write({
      before: new RoleBeforeWriteEvent('create', null, actorOf(actor)),
      work: async (tx, after) => {
        const r = await tx.role.create({
          data: {
            code: dto.code,
            name: dto.name,
            description: dto.description ?? null,
            permissions: {
              create: permissions.map((permission) => ({ permission })),
            },
          },
          select: SELECT,
        });
        after.add(
          new RoleCreatedEvent(actorOf(actor), r.id, r.code, permissions),
        );
        return r;
      },
    });
    return toDto(row);
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actor: Principal,
  ): Promise<RoleDto> {
    const permissions = dto.permissions
      ? assertGrantable(actor, dto.permissions)
      : undefined;
    const row = await this.bus.write({
      before: new RoleBeforeWriteEvent('update', id, actorOf(actor)),
      work: async (tx, after) => {
        const before = await tx.role.findUnique({
          where: { id },
          select: SELECT,
        });
        if (!before) throw new NotFoundException(`Role ${id} not found`);
        if (before.isSystem)
          throw new ForbiddenException(
            `${before.code} is a system role and cannot be changed`,
          );
        // Removing a permission is also a grant decision: the actor must hold what they take away.
        if (permissions)
          assertGrantable(
            actor,
            before.permissions.map((p) => p.permission),
          );
        const r = await tx.role.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            ...(permissions
              ? {
                  permissions: {
                    deleteMany: {},
                    create: permissions.map((permission) => ({ permission })),
                  },
                }
              : {}),
          },
          select: SELECT,
        });
        const changes = diff(toDto(before) as never, toDto(r) as never, [
          'name',
          'description',
          'permissions',
        ]);
        if (Object.keys(changes).length)
          after.add(new RoleUpdatedEvent(actorOf(actor), id, changes));
        return r;
      },
    });
    return toDto(row);
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new RoleBeforeWriteEvent('delete', id, actorOf(actor)),
      work: async (tx, after) => {
        const r = await tx.role.findUnique({ where: { id }, select: SELECT });
        if (!r) throw new NotFoundException(`Role ${id} not found`);
        if (r.isSystem)
          throw new ForbiddenException(
            `${r.code} is a system role and cannot be deleted`,
          );
        if (r._count.users)
          throw new ConflictException(
            `Role ${r.code} is still assigned to ${r._count.users} user(s)`,
          );
        await tx.role.delete({ where: { id } });
        after.add(new RoleDeletedEvent(actorOf(actor), id, r.code));
      },
    });
  }
}
