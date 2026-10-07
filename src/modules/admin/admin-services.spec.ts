import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { API_KEY_PATTERN, sha256 } from '../../common/auth/api-key-format.js';
import type { Principal } from '../../common/auth/principal.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { ApiKeysService } from './api-keys/api-keys.service.js';
import { RolesService } from './roles/roles.service.js';
import { AdminUsersService } from './users/admin-users.service.js';

const root: Principal = {
  type: 'admin',
  id: 'root',
  label: 'root@shop.test',
  permissions: ['*'],
};
const catalogAdmin: Principal = {
  type: 'admin',
  id: 'cat',
  label: 'cat@shop.test',
  permissions: ['catalog:*', 'admin-users:write'],
};

const role = (
  code: string,
  permissions: string[],
  o: Record<string, unknown> = {},
) => ({
  id: `r-${code}`,
  code,
  name: code,
  description: null,
  isSystem: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  permissions: permissions.map((permission) => ({ permission })),
  _count: { users: 0 },
  ...o,
});

describe('RolesService', () => {
  function setup(existing = role('editor', ['catalog:read'])) {
    const tx = {
      role: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(
          async ({
            data,
          }: {
            data: {
              code: string;
              permissions: { create: { permission: string }[] };
            };
          }) =>
            role(
              data.code,
              data.permissions.create.map((p) => p.permission),
            ),
        ),
        update: vi.fn(async () =>
          role('editor', ['catalog:read', 'catalog:write']),
        ),
        delete: vi.fn(async () => existing),
      },
    };
    const fb = fakeBus(tx);
    return { svc: new RolesService({} as never, fb.bus), tx, ...fb };
  }

  it('creates roles with de-duplicated, catalogue-only permissions', async () => {
    const s = setup();
    const r = await s.svc.create(
      {
        code: 'editor',
        name: 'Editor',
        permissions: ['catalog:read', ' catalog:read'],
      },
      root,
    );
    expect(r.permissions).toEqual(['catalog:read']);
    expect(s.afterNames()).toEqual(['role.created']);
    await expect(
      s.svc.create(
        { code: 'x', name: 'X', permissions: ['catalog:fly'] },
        root,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks privilege escalation on create and when removing permissions the actor lacks', async () => {
    const s = setup(role('ops', ['orders:write']));
    await expect(
      s.svc.create(
        { code: 'x', name: 'X', permissions: ['orders:read'] },
        catalogAdmin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.svc.update('r-ops', { permissions: ['catalog:read'] }, catalogAdmin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records only real changes', async () => {
    const s = setup();
    await s.svc.update(
      'r-editor',
      { permissions: ['catalog:read', 'catalog:write'] },
      root,
    );
    expect(s.after[0]).toMatchObject({
      name: 'role.updated',
      audit: {
        changes: {
          permissions: {
            from: ['catalog:read'],
            to: ['catalog:read', 'catalog:write'],
          },
        },
      },
    });
  });

  it('protects system roles and roles still in use', async () => {
    await expect(
      setup(role('super-admin', ['*'], { isSystem: true })).svc.update(
        'r',
        { name: 'x' },
        root,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup(role('super-admin', ['*'], { isSystem: true })).svc.remove(
        'r',
        root,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup(role('editor', [], { _count: { users: 2 } })).svc.remove('r', root),
    ).rejects.toBeInstanceOf(ConflictException);
    const missing = setup(null as never);
    await expect(missing.svc.remove('r', root)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const ok = setup();
    await ok.svc.remove('r-editor', root);
    expect(ok.afterNames()).toEqual(['role.deleted']);
  });

  it('lists the permission catalogue by area', () => {
    const perms = setup().svc.permissions();
    expect(perms).toContainEqual(
      expect.objectContaining({ key: 'cms:publish', area: 'cms' }),
    );
  });
});

describe('ApiKeysService', () => {
  function setup(
    existing: Record<string, unknown> | null = {
      id: 'k1',
      name: 'ERP',
      revokedAt: null,
    },
  ) {
    const tx = {
      apiKey: {
        create: vi.fn(
          async ({
            data: { keyHash: _h, ...data },
          }: {
            data: Record<string, unknown>;
          }) => ({
            id: 'k1',
            ...data,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
            createdBy: { email: 'root@shop.test' },
          }),
        ),
        findUnique: vi.fn(async () => existing),
        update: vi.fn(async () => ({})),
      },
    };
    const fb = fakeBus(tx);
    return { svc: new ApiKeysService({} as never, fb.bus), tx, ...fb };
  }

  it('returns the raw key once and stores only its hash', async () => {
    const s = setup();
    const created = await s.svc.create(
      { name: 'ERP', permissions: ['catalog:read'] },
      root,
    );
    expect(created.key).toMatch(API_KEY_PATTERN);
    const data = s.tx.apiKey.create.mock.calls[0][0].data;
    expect(data.keyHash).toBe(sha256(created.key));
    expect(JSON.stringify(data)).not.toContain(created.key);
    expect(created).not.toHaveProperty('keyHash');
    expect(s.afterNames()).toEqual(['api-key.created']);
  });

  it('rejects past expiry and permissions beyond the creator', async () => {
    const s = setup();
    await expect(
      s.svc.create(
        {
          name: 'x',
          permissions: ['catalog:read'],
          expiresAt: '2000-01-01T00:00:00Z',
        },
        root,
      ),
    ).rejects.toThrow('expiresAt');
    await expect(
      s.svc.create({ name: 'x', permissions: ['*'] }, catalogAdmin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revoke is idempotent', async () => {
    const s = setup();
    await s.svc.revoke('k1', root);
    expect(s.afterNames()).toEqual(['api-key.revoked']);
    const again = setup({ id: 'k1', name: 'ERP', revokedAt: new Date() });
    await again.svc.revoke('k1', root);
    expect(again.tx.apiKey.update).not.toHaveBeenCalled();
    await expect(setup(null).svc.revoke('k1', root)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminUsersService', () => {
  const superRole = role('super-admin', ['*'], { isSystem: true });
  const user = (o: Record<string, unknown> = {}) => ({
    id: 'u2',
    email: 'bob@shop.test',
    firstName: 'Bob',
    lastName: null,
    status: 'ACTIVE',
    lastLoginAt: null,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: [{ role: { id: 'r-editor', code: 'editor', name: 'Editor' } }],
    ...o,
  });

  function setup(
    opts: {
      target?: ReturnType<typeof user> | null;
      superAdmins?: number;
      roles?: ReturnType<typeof role>[];
    } = {},
  ) {
    const roles = opts.roles ?? [role('editor', ['catalog:read'])];
    const target = opts.target === undefined ? user() : opts.target;
    const tx = {
      role: {
        findMany: vi.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            roles.filter((r) => where.id.in.includes(r.id)),
        ),
      },
      adminUser: {
        findFirst: vi.fn(async () => target),
        create: vi.fn(async ({ data }: { data: { email: string } }) =>
          user({ email: data.email }),
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
          user({ ...data, roles: target?.roles }),
        ),
        count: vi.fn(async () => opts.superAdmins ?? 1),
      },
    };
    const sessions = {
      revokeFamilies: vi.fn(async () => ['fam-1']),
      markRevoked: vi.fn(async () => undefined),
    };
    const fb = fakeBus(tx);
    return {
      svc: new AdminUsersService(tx as never, fb.bus, sessions as never),
      tx,
      sessions,
      ...fb,
    };
  }

  it('creates a user with a hashed password and grantable roles', async () => {
    const s = setup();
    await s.svc.create(
      {
        email: 'bob@shop.test',
        password: 'Strong-Pass-123',
        roleIds: ['r-editor'],
      },
      root,
    );
    const data = s.tx.adminUser.create.mock.calls[0][0]
      .data as unknown as Record<string, unknown>;
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(s.afterNames()).toEqual(['admin-user.created']);
  });

  it('refuses weak passwords, unknown roles and roles beyond the actor', async () => {
    const s = setup({ roles: [superRole] });
    await expect(
      s.svc.create({ email: 'b@x.io', password: 'weak', roleIds: [] }, root),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.svc.create(
        { email: 'b@x.io', password: 'Strong-Pass-123', roleIds: ['nope'] },
        root,
      ),
    ).rejects.toThrow('roleIds');
    await expect(
      s.svc.create(
        {
          email: 'b@x.io',
          password: 'Strong-Pass-123',
          roleIds: ['r-super-admin'],
        },
        catalogAdmin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids self-disable, self role change and self-delete', async () => {
    const s = setup();
    await expect(
      s.svc.update('root', { status: 'DISABLED' }, root),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.svc.update('root', { roleIds: [] }, root),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.svc.remove('root', root)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('disabling a user ends their sessions immediately', async () => {
    const s = setup();
    await s.svc.update('u2', { status: 'DISABLED' }, root);
    expect(s.sessions.revokeFamilies).toHaveBeenCalledWith(s.tx, {
      adminUserId: 'u2',
    });
    expect(s.sessions.markRevoked).toHaveBeenCalledWith(['fam-1']);
    expect(s.after[0]).toMatchObject({
      name: 'admin-user.updated',
      audit: { changes: { status: { from: 'ACTIVE', to: 'DISABLED' } } },
    });
  });

  it('never leaves the shop without an active super-admin', async () => {
    const s = setup({
      target: user({
        roles: [
          {
            role: {
              id: 'r-super-admin',
              code: 'super-admin',
              name: 'Super admin',
            },
          },
        ],
      }),
      roles: [superRole],
      superAdmins: 0,
    });
    await expect(s.svc.remove('u2', root)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.afterNames()).toEqual([]);
  });

  it('a lesser admin cannot delete someone holding more power', async () => {
    const s = setup({
      target: user({
        roles: [
          {
            role: {
              id: 'r-super-admin',
              code: 'super-admin',
              name: 'Super admin',
            },
          },
        ],
      }),
      roles: [superRole],
      superAdmins: 2,
    });
    await expect(s.svc.remove('u2', catalogAdmin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('soft-deletes, frees the e-mail and revokes sessions', async () => {
    const s = setup();
    await s.svc.remove('u2', root);
    expect(s.tx.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'deleted+u2@invalid',
          status: 'DISABLED',
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(s.sessions.markRevoked).toHaveBeenCalledWith(['fam-1']);
    expect(s.afterNames()).toEqual(['admin-user.deleted']);
  });

  it('admin password reset unlocks and ends sessions', async () => {
    const s = setup();
    await s.svc.resetPassword('u2', 'Another-Strong-9', root);
    expect(s.tx.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLogins: 0, lockedUntil: null }),
      }),
    );
    expect(s.after[0]).toMatchObject({
      name: 'admin-user.password-changed',
      audit: { changes: { by: 'admin' } },
    });
  });
});
