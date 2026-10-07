import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import { API_KEY_PATTERN, sha256 } from './api-key-format.js';
import type { Principal } from './principal.js';

export const ACCESS_AUDIENCE = 'shop-admin';
const CACHE_TTL_S = 30;
const KEY_USED_THROTTLE_S = 300;
/** Bumped when roles change: every cached admin principal becomes stale at once. */
export const PRINCIPAL_VERSION_KEY = 'auth:principal-version';
export const revokedSessionKey = (sid: string) => `auth:revoked-session:${sid}`;
const adminKey = (ver: string, id: string) => `auth:admin:${ver}:${id}`;
const apiKeyCacheKey = (ver: string, prefix: string) =>
  `auth:api-key:${ver}:${prefix}`;

export interface AccessClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

interface CachedAdmin {
  id: string;
  email: string;
  permissions: string[];
  passwordChangedAt: number;
}

interface CachedKey {
  id: string;
  name: string;
  keyHash: string;
  permissions: string[];
  expiresAt: number | null;
}

/**
 * Turns credentials into a Principal. Results are cached for 30 s; changes to users, roles or
 * keys invalidate the cache through after-event listeners (AuthCacheListener).
 */
@Injectable()
export class PrincipalResolver {
  private readonly logger = new Logger(PrincipalResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private async version(): Promise<string> {
    return (
      (await this.redis.get(PRINCIPAL_VERSION_KEY).catch(() => null)) ?? '0'
    );
  }

  async fromAccessToken(token: string): Promise<Principal> {
    const { jwtSecret, issuer } = this.config.get('auth', { infer: true });
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token, {
        secret: jwtSecret,
        issuer,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (await this.redis.exists(revokedSessionKey(claims.sid)).catch(() => 0))
      throw new UnauthorizedException('Session has ended');

    const ver = await this.version();
    const cacheKey = adminKey(ver, claims.sub);
    let admin = await this.readCache<CachedAdmin>(cacheKey);
    if (!admin) {
      const row = await this.prisma.adminUser.findFirst({
        where: { id: claims.sub, deletedAt: null, status: 'ACTIVE' },
        select: {
          id: true,
          email: true,
          passwordChangedAt: true,
          roles: {
            select: {
              role: {
                select: { permissions: { select: { permission: true } } },
              },
            },
          },
        },
      });
      if (!row) throw new UnauthorizedException('Account is not active');
      admin = {
        id: row.id,
        email: row.email,
        passwordChangedAt: row.passwordChangedAt.getTime(),
        permissions: [
          ...new Set(
            row.roles.flatMap((r) =>
              r.role.permissions.map((p) => p.permission),
            ),
          ),
        ],
      };
      await this.redis
        .set(cacheKey, JSON.stringify(admin), 'EX', CACHE_TTL_S)
        .catch(() => undefined);
    }
    // Tokens issued before a password change are void (1 s tolerance for clock granularity).
    if (claims.iat * 1000 < admin.passwordChangedAt - 1000)
      throw new UnauthorizedException('Password was changed; sign in again');
    return {
      type: 'admin',
      id: admin.id,
      label: admin.email,
      permissions: admin.permissions,
      sessionId: claims.sid,
    };
  }

  async fromApiKey(raw: string): Promise<Principal> {
    const m = API_KEY_PATTERN.exec(raw);
    if (!m) throw new UnauthorizedException('Invalid API key');
    const prefix = m[1];
    const ver = await this.version();
    const cacheKey = apiKeyCacheKey(ver, prefix);
    let key = await this.readCache<CachedKey>(cacheKey);
    if (!key) {
      const row = await this.prisma.apiKey.findFirst({
        where: { prefix, revokedAt: null },
        select: {
          id: true,
          name: true,
          keyHash: true,
          permissions: true,
          expiresAt: true,
        },
      });
      if (!row) throw new UnauthorizedException('Invalid API key');
      key = {
        ...row,
        permissions: row.permissions ?? [],
        expiresAt: row.expiresAt?.getTime() ?? null,
      };
      await this.redis
        .set(cacheKey, JSON.stringify(key), 'EX', CACHE_TTL_S)
        .catch(() => undefined);
    }
    const presented = Buffer.from(sha256(raw), 'hex');
    const stored = Buffer.from(key.keyHash, 'hex');
    if (
      presented.length !== stored.length ||
      !timingSafeEqual(presented, stored)
    )
      throw new UnauthorizedException('Invalid API key');
    if (key.expiresAt !== null && key.expiresAt < Date.now())
      throw new UnauthorizedException('API key expired');
    void this.touch(key.id);
    return {
      type: 'api-key',
      id: key.id,
      label: key.name,
      permissions: key.permissions,
    };
  }

  /** `last_used_at` at most every 5 minutes per key (telemetry, not audited). */
  private async touch(id: string): Promise<void> {
    try {
      if (
        (await this.redis.set(
          `auth:key-used:${id}`,
          '1',
          'EX',
          KEY_USED_THROTTLE_S,
          'NX',
        )) !== 'OK'
      )
        return;
      await this.prisma.apiKey.update({
        where: { id },
        data: { lastUsedAt: new Date() },
      });
    } catch (e) {
      this.logger.debug(`last_used_at update skipped: ${(e as Error).message}`);
    }
  }

  private async readCache<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key).catch(() => null);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Called by AuthCacheListener after users / roles / keys change. */
  async invalidateAll(): Promise<void> {
    await this.redis.incr(PRINCIPAL_VERSION_KEY).catch(() => undefined);
  }
}
