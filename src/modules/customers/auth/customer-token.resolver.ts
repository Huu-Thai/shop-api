import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../../config/configuration.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../../redis/redis.module.js';
import type {
  CustomerTokenResolver,
  StorefrontCustomer,
} from '../../stores/context/store-context.js';
import {
  CUSTOMER_AUDIENCE,
  type CustomerClaims,
  revokedCustomerSessionKey,
} from './customer-tokens.js';

/**
 * Verifies customer access tokens: signature, audience, revocation (logout), and that the account
 * is still active and its password unchanged since the token was issued. The customer row is read
 * on every request so a disabled account or changed group takes effect at once.
 */
@Injectable()
export class CustomerTokenResolverService implements CustomerTokenResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async resolve(token: string): Promise<StorefrontCustomer> {
    const { jwtSecret, issuer } = this.config.get('auth', { infer: true });
    let claims: CustomerClaims;
    try {
      claims = await this.jwt.verifyAsync<CustomerClaims>(token, {
        secret: jwtSecret,
        issuer,
        audience: CUSTOMER_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (
      await this.redis
        .exists(revokedCustomerSessionKey(claims.sid))
        .catch(() => 0)
    )
      throw new UnauthorizedException('Session has ended');
    const c = await this.prisma.customer.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        websiteId: true,
        email: true,
        status: true,
        passwordChangedAt: true,
        customerGroup: { select: { id: true, code: true } },
      },
    });
    if (
      !c ||
      c.status !== 'ACTIVE' ||
      c.websiteId !== claims.ws ||
      Math.floor(c.passwordChangedAt.getTime() / 1000) > claims.iat
    )
      throw new UnauthorizedException('Session has ended');
    return {
      id: c.id,
      websiteId: c.websiteId,
      email: c.email,
      groupId: c.customerGroup.id,
      groupCode: c.customerGroup.code,
      sessionId: claims.sid,
    };
  }
}
