import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import { sha256 } from '../../../common/auth/api-key-format.js';
import {
  ACCESS_AUDIENCE,
  revokedSessionKey,
} from '../../../common/auth/principal.resolver.js';
import type { AppConfig } from '../../../config/configuration.js';
import type { PrismaTransaction } from '../../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../../redis/redis.module.js';
import type { TokenPairDto } from './dto/auth.dto.js';

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Token mechanics only (no events): access JWTs and rotating refresh tokens inside a caller's tx. */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private get settings() {
    return this.config.get('auth', { infer: true });
  }

  /** New refresh token in family `familyId` (a new family on login) + a matching access token. */
  async issue(
    tx: PrismaTransaction,
    adminUserId: string,
    meta: ClientMeta,
    familyId: string = randomUUID(),
  ): Promise<{ pair: TokenPairDto; refreshTokenId: string; familyId: string }> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.settings.refreshTtlDays * 86_400_000,
    );
    const row = await tx.refreshToken.create({
      data: {
        adminUserId,
        familyId,
        tokenHash: sha256(raw),
        expiresAt,
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
      },
      select: { id: true },
    });
    const { jwtSecret, issuer, accessTtlSeconds } = this.settings;
    const accessToken = await this.jwt.signAsync(
      { sub: adminUserId, sid: familyId },
      {
        secret: jwtSecret,
        issuer,
        audience: ACCESS_AUDIENCE,
        expiresIn: accessTtlSeconds,
        algorithm: 'HS256',
      },
    );
    return {
      pair: {
        tokenType: 'Bearer',
        accessToken,
        expiresIn: accessTtlSeconds,
        refreshToken: raw,
        refreshTokenExpiresAt: expiresAt,
      },
      refreshTokenId: row.id,
      familyId,
    };
  }

  /** Revokes refresh tokens (in tx). Access tokens are cut off after commit via `markRevoked`. */
  async revokeFamilies(
    tx: PrismaTransaction,
    where: { familyId?: string; adminUserId?: string },
  ): Promise<string[]> {
    const families = await tx.refreshToken.findMany({
      where: { ...where, revokedAt: null },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await tx.refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return families.map((f) => f.familyId);
  }

  /** Access tokens of these sessions stop working immediately (until they would expire anyway). */
  async markRevoked(familyIds: string[]): Promise<void> {
    const ttl = this.settings.accessTtlSeconds + 60;
    await Promise.all(
      familyIds.map((id) =>
        this.redis
          .set(revokedSessionKey(id), '1', 'EX', ttl)
          .catch(() => undefined),
      ),
    );
  }
}
