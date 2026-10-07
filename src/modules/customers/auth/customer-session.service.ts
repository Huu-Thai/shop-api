import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import { sha256 } from '../../../common/auth/api-key-format.js';
import type { AppConfig } from '../../../config/configuration.js';
import type { PrismaTransaction } from '../../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../../redis/redis.module.js';
import type { CustomerTokenPairDto } from '../dto/account.dto.js';
import {
  CUSTOMER_AUDIENCE,
  revokedCustomerSessionKey,
} from './customer-tokens.js';

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Customer token mechanics (no events): access JWTs and rotating refresh tokens in a caller's tx. */
@Injectable()
export class CustomerSessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private get settings() {
    return this.config.get('auth', { infer: true });
  }

  async issue(
    tx: PrismaTransaction,
    customer: { id: string; websiteId: string },
    meta: ClientMeta,
    familyId: string = randomUUID(),
  ): Promise<{
    pair: CustomerTokenPairDto;
    sessionRowId: string;
    familyId: string;
  }> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.settings.refreshTtlDays * 86_400_000,
    );
    const row = await tx.customerSession.create({
      data: {
        customerId: customer.id,
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
      { sub: customer.id, sid: familyId, ws: customer.websiteId },
      {
        secret: jwtSecret,
        issuer,
        audience: CUSTOMER_AUDIENCE,
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
      sessionRowId: row.id,
      familyId,
    };
  }

  async revokeFamilies(
    tx: PrismaTransaction,
    where: { familyId?: string; customerId?: string },
  ): Promise<string[]> {
    const families = await tx.customerSession.findMany({
      where: { ...where, revokedAt: null },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await tx.customerSession.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return families.map((f) => f.familyId);
  }

  /** Access tokens of these sessions stop working immediately. */
  async markRevoked(familyIds: readonly string[]): Promise<void> {
    const ttl = this.settings.accessTtlSeconds + 60;
    await Promise.all(
      [...new Set(familyIds)].map((id) =>
        this.redis
          .set(revokedCustomerSessionKey(id), '1', 'EX', ttl)
          .catch(() => undefined),
      ),
    );
  }
}
