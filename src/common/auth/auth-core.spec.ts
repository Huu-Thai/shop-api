import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ADMIN_ONLY_KEY,
  AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators/auth.decorators.js';
import { API_KEY_PATTERN, generateApiKey, sha256 } from './api-key-format.js';
import { AuthGuard } from './auth.guard.js';
import { hashPassword, passwordProblems, verifyPassword } from './password.js';
import { canGrant, hasPermission, isGrantable } from './permissions.js';
import {
  ACCESS_AUDIENCE,
  PrincipalResolver,
  revokedSessionKey,
} from './principal.resolver.js';
import { PrincipalThrottlerGuard } from './throttler.guard.js';

describe('permissions', () => {
  it('matches exact, area wildcard and global wildcard', () => {
    expect(hasPermission(['catalog:read'], 'catalog:read')).toBe(true);
    expect(hasPermission(['catalog:*'], 'catalog:write')).toBe(true);
    expect(hasPermission(['*'], 'orders:write')).toBe(true);
    expect(hasPermission(['catalog:read'], 'catalog:write')).toBe(false);
    expect(hasPermission(['catalog:*'], 'pricing:read')).toBe(false);
  });

  it('only catalogue entries, area wildcards of known areas, and * are grantable', () => {
    expect(isGrantable('catalog:write')).toBe(true);
    expect(isGrantable('cms:*')).toBe(true);
    expect(isGrantable('*')).toBe(true);
    expect(isGrantable('catalog:delete-everything')).toBe(false);
    expect(isGrantable('nope:*')).toBe(false);
  });

  it('prevents privilege escalation', () => {
    expect(canGrant(['catalog:*'], 'catalog:write')).toBe(true);
    expect(canGrant(['catalog:*'], 'catalog:*')).toBe(true);
    expect(canGrant(['catalog:read', 'catalog:write'], 'catalog:*')).toBe(
      false,
    ); // future actions
    expect(canGrant(['catalog:*'], '*')).toBe(false);
    expect(canGrant(['*'], '*')).toBe(true);
  });
});

describe('passwords', () => {
  it('hashes with a salt and verifies in constant time', async () => {
    const a = await hashPassword('Correct-Horse-9');
    const b = await hashPassword('Correct-Horse-9');
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('Correct-Horse-9', a)).toBe(true);
    expect(await verifyPassword('correct-horse-9', a)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(passwordProblems('Sh0rt!')).toContain(
      'must be at least 12 characters',
    );
    expect(passwordProblems('alllowercaseletters')).toContain(
      'must mix at least 3 of: lower case, upper case, digits, symbols',
    );
    expect(passwordProblems('Ana-Admin-2026!', 'ana@shop.local')).toContain(
      'must not contain your e-mail name',
    );
    expect(passwordProblems('Tr0ub4dor&3-horse')).toEqual([]);
  });
});

describe('API key format', () => {
  it('generates keys whose prefix and hash identify them', () => {
    const { key, prefix, hash } = generateApiKey();
    const m = API_KEY_PATTERN.exec(key)!;
    expect(m[1]).toBe(prefix);
    expect(hash).toBe(sha256(key));
    expect(generateApiKey().key).not.toBe(key);
  });
});

function ctx(headers: Record<string, string> = {}) {
  const request: Record<string, unknown> = { headers, ip: '10.0.0.9' };
  const context = {
    getHandler: () => ({ name: 'handler' }),
    getClass: () => ({ name: 'Ctrl' }),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('AuthGuard', () => {
  const admin = {
    type: 'admin' as const,
    id: 'u1',
    label: 'ana@x',
    permissions: ['catalog:*'],
  };
  const key = {
    type: 'api-key' as const,
    id: 'k1',
    label: 'ERP',
    permissions: ['catalog:read'],
  };
  function guard(meta: Record<string, unknown>) {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(
      (k) => meta[k as string],
    );
    const resolver = {
      fromAccessToken: vi.fn(async () => admin),
      fromApiKey: vi.fn(async () => key),
    };
    return { g: new AuthGuard(reflector, resolver as never), resolver };
  }

  it('lets @Public routes through without credentials', async () => {
    expect(
      await guard({ [IS_PUBLIC_KEY]: true }).g.canActivate(ctx().context),
    ).toBe(true);
  });

  it('denies routes that declare no auth policy, even with valid credentials', async () => {
    await expect(
      guard({}).g.canActivate(ctx({ authorization: 'Bearer t' }).context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires credentials and checks every required permission', async () => {
    const { g } = guard({ [PERMISSIONS_KEY]: ['catalog:write'] });
    await expect(g.canActivate(ctx().context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const ok = ctx({ authorization: 'Bearer token' });
    expect(await g.canActivate(ok.context)).toBe(true);
    expect(ok.request.principal).toEqual(admin);
    await expect(
      g.canActivate(ctx({ 'x-api-key': 'shk_x' }).context),
    ).rejects.toThrow('Missing permission: catalog:write');
  });

  it('@Authenticated needs no permission; @AdminOnly refuses API keys', async () => {
    expect(
      await guard({ [AUTHENTICATED_KEY]: true }).g.canActivate(
        ctx({ 'x-api-key': 'shk_x' }).context,
      ),
    ).toBe(true);
    await expect(
      guard({
        [AUTHENTICATED_KEY]: true,
        [ADMIN_ONLY_KEY]: true,
      }).g.canActivate(ctx({ 'x-api-key': 'shk_x' }).context),
    ).rejects.toThrow('Only admin users');
  });

  it('rate-limits per principal, per IP when anonymous', async () => {
    const t = new PrincipalThrottlerGuard(
      { throttlers: [] } as never,
      {} as never,
      new Reflector(),
    );
    const tracker = (r: Record<string, unknown>) =>
      (
        t as unknown as { getTracker: (r: unknown) => Promise<string> }
      ).getTracker(r);
    expect(await tracker({ principal: admin, ip: '1.1.1.1' })).toBe('admin:u1');
    expect(await tracker({ ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
  });
});

describe('PrincipalResolver', () => {
  const SECRET = 'unit-test-jwt-secret-0123456789-abcdef';
  const config = {
    get: () => ({ jwtSecret: SECRET, issuer: 'shop', accessTtlSeconds: 900 }),
  };
  const jwt = new JwtService({});
  const sign = (
    claims: Record<string, unknown>,
    opts: Record<string, unknown> = {},
  ) =>
    jwt.signAsync(claims, {
      secret: SECRET,
      issuer: 'shop',
      audience: ACCESS_AUDIENCE,
      expiresIn: 900,
      ...opts,
    });

  function setup(
    user: Record<string, unknown> | null,
    apiKey: Record<string, unknown> | null = null,
  ) {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => (store.set(k, v), 'OK')),
      exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
      incr: vi.fn(async (k: string) => {
        store.set(k, String(Number(store.get(k) ?? 0) + 1));
        return 1;
      }),
    };
    const prisma = {
      adminUser: { findFirst: vi.fn(async () => user) },
      apiKey: {
        findFirst: vi.fn(async () => apiKey),
        update: vi.fn(async () => ({})),
      },
    };
    return {
      r: new PrincipalResolver(
        prisma as never,
        jwt,
        config as never,
        redis as never,
      ),
      prisma,
      store,
    };
  }
  const user = {
    id: 'u1',
    email: 'ana@x',
    passwordChangedAt: new Date(Date.now() - 3_600_000),
    roles: [
      {
        role: {
          permissions: [
            { permission: 'catalog:*' },
            { permission: 'orders:read' },
          ],
        },
      },
      { role: { permissions: [{ permission: 'orders:read' }] } },
    ],
  };

  it('resolves an admin from a valid access token and caches it', async () => {
    const { r, prisma } = setup(user);
    const token = await sign({ sub: 'u1', sid: 's1' });
    expect(await r.fromAccessToken(token)).toEqual({
      type: 'admin',
      id: 'u1',
      label: 'ana@x',
      permissions: ['catalog:*', 'orders:read'],
      sessionId: 's1',
    });
    await r.fromAccessToken(token);
    expect(prisma.adminUser.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects forged, wrong-audience, logged-out, inactive and pre-password-change tokens', async () => {
    const { r, store } = setup(user);
    await expect(
      r.fromAccessToken(
        await sign(
          { sub: 'u1', sid: 's1' },
          { secret: 'another-secret-0123456789-0123456789' },
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      r.fromAccessToken(
        await sign({ sub: 'u1', sid: 's1' }, { audience: 'storefront' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    store.set(revokedSessionKey('gone'), '1');
    await expect(
      r.fromAccessToken(await sign({ sub: 'u1', sid: 'gone' })),
    ).rejects.toThrow('Session has ended');
    await expect(
      setup(null).r.fromAccessToken(await sign({ sub: 'u1', sid: 's1' })),
    ).rejects.toThrow('Account is not active');
    const changed = setup({
      ...user,
      passwordChangedAt: new Date(Date.now() + 60_000),
    });
    await expect(
      changed.r.fromAccessToken(await sign({ sub: 'u1', sid: 's1' })),
    ).rejects.toThrow('Password was changed');
  });

  it('verifies API keys by prefix + hash and respects expiry', async () => {
    const { key, prefix, hash } = generateApiKey();
    const row = {
      id: 'k1',
      name: 'ERP',
      keyHash: hash,
      permissions: ['catalog:read'],
      expiresAt: null,
    };
    const ok = setup(null, row);
    expect(await ok.r.fromApiKey(key)).toEqual({
      type: 'api-key',
      id: 'k1',
      label: 'ERP',
      permissions: ['catalog:read'],
    });
    expect(ok.prisma.apiKey.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { prefix, revokedAt: null } }),
    ]);
    await expect(
      ok.r.fromApiKey(`shk_${prefix}_${'A'.repeat(43)}`),
    ).rejects.toThrow('Invalid API key');
    await expect(ok.r.fromApiKey('not-a-key')).rejects.toThrow(
      'Invalid API key',
    );
    const expired = setup(null, {
      ...row,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(expired.r.fromApiKey(key)).rejects.toThrow('API key expired');
  });

  it('invalidates every cached principal at once', async () => {
    const { r, prisma } = setup(user);
    const token = await sign({ sub: 'u1', sid: 's1' });
    await r.fromAccessToken(token);
    await r.invalidateAll();
    await r.fromAccessToken(token);
    expect(prisma.adminUser.findFirst).toHaveBeenCalledTimes(2);
  });
});
