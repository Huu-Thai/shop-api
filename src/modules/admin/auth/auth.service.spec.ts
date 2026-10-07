import { UnauthorizedException } from '@nestjs/common';
import { sha256 } from '../../../common/auth/api-key-format.js';
import { hashPassword } from '../../../common/auth/password.js';
import type { Principal } from '../../../common/auth/principal.js';
import { fakeBus } from '../../../testing/fake-bus.js';
import { AuthService } from './auth.service.js';

const PASSWORD = 'Correct-Horse-9';
const pair = {
  tokenType: 'Bearer',
  accessToken: 'a',
  expiresIn: 900,
  refreshToken: 'r',
  refreshTokenExpiresAt: new Date(),
};

async function setup(overrides: Record<string, unknown> = {}) {
  const user = {
    id: 'u1',
    email: 'ana@shop.test',
    passwordHash: await hashPassword(PASSWORD),
    status: 'ACTIVE',
    failedLogins: 0,
    lockedUntil: null as Date | null,
    ...overrides,
  };
  const tx = {
    adminUser: {
      update: vi.fn(async (args: { data: { failedLogins?: unknown } }) => ({
        failedLogins:
          typeof args.data.failedLogins === 'object'
            ? user.failedLogins + 1
            : 0,
      })),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    adminUser: {
      findFirst: vi.fn(async () => user),
      findUniqueOrThrow: vi.fn(async () => user),
    },
    refreshToken: { findUnique: vi.fn() },
  };
  const sessions = {
    issue: vi.fn(
      async (_tx: unknown, _id: string, _m: unknown, familyId = 'fam-new') => ({
        pair,
        refreshTokenId: 'rt-new',
        familyId,
      }),
    ),
    revokeFamilies: vi.fn(async () => ['fam-1', 'fam-2']),
    markRevoked: vi.fn(async () => undefined),
  };
  const config = { get: () => ({ maxFailedLogins: 3, lockoutMinutes: 15 }) };
  const fb = fakeBus(tx);
  const svc = new AuthService(
    prisma as never,
    fb.bus,
    sessions as never,
    config as never,
  );
  return { svc, user, tx, prisma, sessions, ...fb };
}
const meta = { ip: '10.0.0.1', userAgent: 'vitest' };

describe('AuthService.login', () => {
  it('issues a token pair, resets failures and emits auth.logged-in', async () => {
    const { svc, tx, sessions, afterNames } = await setup({ failedLogins: 2 });
    expect(await svc.login('ana@shop.test', PASSWORD, meta)).toBe(pair);
    expect(tx.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLogins: 0, lockedUntil: null }),
      }),
    );
    expect(sessions.issue).toHaveBeenCalledWith(tx, 'u1', meta);
    expect(afterNames()).toEqual(['auth.logged-in']);
  });

  it('gives the same generic error for unknown e-mail, wrong password, disabled and locked accounts', async () => {
    const unknown = await setup();
    unknown.prisma.adminUser.findFirst.mockResolvedValueOnce(null as never);
    for (const [s, pw] of [
      [unknown, PASSWORD],
      [await setup(), 'Wrong-Horse-99'],
      [await setup({ status: 'DISABLED' }), PASSWORD],
      [await setup({ lockedUntil: new Date(Date.now() + 60_000) }), PASSWORD],
    ] as const)
      await expect(s.svc.login('ana@shop.test', pw, meta)).rejects.toThrow(
        new UnauthorizedException('Invalid e-mail or password'),
      );
  });

  it('counts failures atomically and locks the account at the threshold', async () => {
    const once = await setup();
    await expect(
      once.svc.login('ana@shop.test', 'nope', meta),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(once.tx.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedLogins: { increment: 1 } } }),
    );
    expect(once.afterNames()).toEqual(['auth.login-failed']);

    const last = await setup({ failedLogins: 2 });
    await expect(
      last.svc.login('ana@shop.test', 'nope', meta),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(last.afterNames()).toEqual([
      'auth.login-failed',
      'auth.account-locked',
    ]);
    expect(last.tx.adminUser.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failedLogins: 0,
          lockedUntil: expect.any(Date),
        }),
      }),
    );
  });

  it('does not count failures while locked (no lock extension by guessing)', async () => {
    const s = await setup({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(
      s.svc.login('ana@shop.test', 'nope', meta),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(s.bus.write).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh', () => {
  const owner = {
    id: 'u1',
    email: 'ana@shop.test',
    status: 'ACTIVE',
    deletedAt: null,
  };
  const token = (o: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    familyId: 'fam-1',
    revokedAt: null,
    replacedById: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    adminUser: owner,
    ...o,
  });

  it('rotates: new token in the same family, old one replaced via compare-and-set', async () => {
    const s = await setup();
    s.prisma.refreshToken.findUnique.mockResolvedValue(token());
    expect(await s.svc.refresh('raw', meta)).toBe(pair);
    expect(s.prisma.refreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256('raw') } }),
    );
    expect(s.sessions.issue).toHaveBeenCalledWith(s.tx, 'u1', meta, 'fam-1');
    expect(s.tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', replacedById: null, revokedAt: null },
      data: { replacedById: 'rt-new', revokedAt: expect.any(Date) },
    });
  });

  it('loses the race cleanly when a concurrent refresh already rotated the token', async () => {
    const s = await setup();
    s.prisma.refreshToken.findUnique.mockResolvedValue(token());
    s.tx.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow('no longer valid');
  });

  it('treats reuse of a rotated token as theft: revokes the family and cuts access tokens', async () => {
    const s = await setup();
    s.prisma.refreshToken.findUnique.mockResolvedValue(
      token({ replacedById: 'rt-2', revokedAt: new Date() }),
    );
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow('no longer valid');
    expect(s.sessions.revokeFamilies).toHaveBeenCalledWith(s.tx, {
      familyId: 'fam-1',
    });
    expect(s.sessions.markRevoked).toHaveBeenCalledWith(['fam-1', 'fam-2']);
    expect(s.afterNames()).toEqual(['auth.token-reuse-detected']);
  });

  it('rejects unknown, logged-out, expired tokens and inactive owners', async () => {
    const s = await setup();
    s.prisma.refreshToken.findUnique.mockResolvedValueOnce(null);
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow(
      'Invalid refresh token',
    );
    s.prisma.refreshToken.findUnique.mockResolvedValueOnce(
      token({ revokedAt: new Date() }),
    );
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow('no longer valid');
    expect(s.sessions.revokeFamilies).not.toHaveBeenCalled(); // plain logout is not theft
    s.prisma.refreshToken.findUnique.mockResolvedValueOnce(
      token({ expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow('Session expired');
    s.prisma.refreshToken.findUnique.mockResolvedValueOnce(
      token({ adminUser: { ...owner, status: 'DISABLED' } }),
    );
    await expect(s.svc.refresh('raw', meta)).rejects.toThrow('Session expired');
  });
});

describe('AuthService logout / changePassword', () => {
  const principal: Principal = {
    type: 'admin',
    id: 'u1',
    label: 'ana@shop.test',
    permissions: ['*'],
    sessionId: 'fam-9',
  };

  it('logout ends this session, or all of them', async () => {
    const s = await setup();
    await s.svc.logout(principal, false);
    expect(s.sessions.revokeFamilies).toHaveBeenLastCalledWith(s.tx, {
      familyId: 'fam-9',
    });
    expect(s.sessions.markRevoked).toHaveBeenLastCalledWith([
      'fam-1',
      'fam-2',
      'fam-9',
    ]);
    await s.svc.logout(principal, true);
    expect(s.sessions.revokeFamilies).toHaveBeenLastCalledWith(s.tx, {
      adminUserId: 'u1',
    });
    expect(s.afterNames()).toEqual(['auth.logged-out', 'auth.logged-out']);
  });

  it('changePassword verifies the current one, enforces policy, and ends every session', async () => {
    const s = await setup();
    await expect(
      s.svc.changePassword(principal, 'wrong', 'Brand-New-Pass-7'),
    ).rejects.toThrow('Current password is wrong');
    await expect(
      s.svc.changePassword(principal, PASSWORD, 'short'),
    ).rejects.toThrow();
    await expect(
      s.svc.changePassword(principal, PASSWORD, PASSWORD),
    ).rejects.toThrow();
    expect(s.bus.write).not.toHaveBeenCalled();

    await s.svc.changePassword(principal, PASSWORD, 'Brand-New-Pass-7');
    expect(s.tx.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        passwordHash: expect.stringMatching(/^scrypt\$/),
        passwordChangedAt: expect.any(Date),
      },
    });
    expect(s.sessions.revokeFamilies).toHaveBeenCalledWith(s.tx, {
      adminUserId: 'u1',
    });
    expect(s.sessions.markRevoked).toHaveBeenCalled();
    expect(s.beforeNames()).toEqual(['admin-user.before-write']);
    expect(s.afterNames()).toEqual(['admin-user.password-changed']);
  });
});
