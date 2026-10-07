import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '../../../common/auth/api-key-format.js';
import {
  dummyHash,
  hashPassword,
  passwordProblems,
  verifyPassword,
} from '../../../common/auth/password.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../../config/configuration.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  StoreContext,
  StorefrontCustomer,
} from '../../stores/context/store-context.js';
import { CustomersQuery } from '../customers.query.js';
import {
  CUSTOMER_EVENTS,
  type CustomerEventData,
  customerActor,
  DEFAULT_CUSTOMER_GROUP,
} from '../customers.events.js';
import type { CustomerTokenPairDto, RegisterDto } from '../dto/account.dto.js';
import {
  type ClientMeta,
  CustomerSessionService,
} from './customer-session.service.js';

const INVALID = 'Invalid e-mail or password';

/**
 * Storefront sign-up and sessions. Accounts are per website, so the store of the request decides
 * which account an e-mail means. Same protections as the admin: one generic login error with equal
 * work, lockout after repeated failures, single-use refresh tokens with reuse detection.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly sessions: CustomerSessionService,
    private readonly customers: CustomersQuery,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get settings() {
    return this.config.get('auth', { infer: true });
  }

  async register(
    ctx: StoreContext,
    dto: RegisterDto,
    meta: ClientMeta,
  ): Promise<CustomerTokenPairDto> {
    const problems = passwordProblems(dto.password, dto.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `password ${p}`));
    const group = await this.customers.groupByCode(DEFAULT_CUSTOMER_GROUP);
    const passwordHash = await hashPassword(dto.password);
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_WRITE,
        'register',
        null,
        { type: 'customer', id: null, label: dto.email },
        { websiteId: ctx.websiteId, customerGroupId: group.id },
      ),
      work: async (tx, after) => {
        const c = await tx.customer.create({
          data: {
            websiteId: ctx.websiteId,
            email: dto.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            customerGroupId: group.id,
            localeCode: ctx.localeCode,
            acceptsMarketing: dto.acceptsMarketing ?? false,
            lastLoginAt: new Date(),
            // App clock, like the token's `iat` (the resolver compares the two).
            passwordChangedAt: new Date(),
          },
          select: { id: true, email: true, websiteId: true },
        });
        const { pair } = await this.sessions.issue(tx, c, meta);
        after.add(
          new EntityEvent<CustomerEventData>(
            CUSTOMER_EVENTS.REGISTERED,
            customerActor(c),
            'customer',
            c.id,
            {
              storeCode: ctx.storeCode,
              acceptsMarketing: dto.acceptsMarketing ?? false,
            },
            {
              customerId: c.id,
              websiteId: c.websiteId,
              customerGroupId: group.id,
            },
          ),
        );
        return pair;
      },
    });
  }

  async login(
    ctx: StoreContext,
    email: string,
    password: string,
    meta: ClientMeta,
  ): Promise<CustomerTokenPairDto> {
    const c = await this.prisma.customer.findUnique({
      where: { websiteId_email: { websiteId: ctx.websiteId, email } },
      select: {
        id: true,
        email: true,
        websiteId: true,
        passwordHash: true,
        status: true,
        lockedUntil: true,
      },
    });
    const ok = await verifyPassword(
      password,
      c?.passwordHash ?? (await dummyHash()),
    );
    if (!c) throw new UnauthorizedException(INVALID);
    const locked = c.lockedUntil !== null && c.lockedUntil > new Date();
    if (!ok || locked || c.status !== 'ACTIVE') {
      if (!ok && !locked) await this.recordFailure(c);
      throw new UnauthorizedException(INVALID);
    }
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'login',
        c.id,
        customerActor(c),
      ),
      work: async (tx, after) => {
        await tx.customer.update({
          where: { id: c.id },
          data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        const { pair, familyId } = await this.sessions.issue(tx, c, meta);
        after.add(
          new ProjectionEvent(CUSTOMER_EVENTS.LOGGED_IN, {
            customerId: c.id,
            sessionId: familyId,
          }),
        );
        return pair;
      },
    });
  }

  private async recordFailure(c: { id: string; email: string }): Promise<void> {
    const { maxFailedLogins, lockoutMinutes } = this.settings;
    await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'login-failed',
        c.id,
        customerActor(c),
      ),
      work: async (tx, after) => {
        // Atomic increment: concurrent guesses can't slip past the threshold.
        const row = await tx.customer.update({
          where: { id: c.id },
          data: { failedLogins: { increment: 1 } },
          select: { failedLogins: true },
        });
        after.add(
          new ProjectionEvent(CUSTOMER_EVENTS.LOGIN_FAILED, {
            customerId: c.id,
            failedLogins: row.failedLogins,
          }),
        );
        if (row.failedLogins >= maxFailedLogins) {
          const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000);
          await tx.customer.update({
            where: { id: c.id },
            data: { lockedUntil, failedLogins: 0 },
          });
          after.add(
            new EntityEvent(
              CUSTOMER_EVENTS.LOCKED,
              customerActor(c),
              'customer',
              c.id,
              { lockedUntil: lockedUntil.toISOString() },
            ),
          );
        }
      },
    });
  }

  /** Rotation: each refresh token works once; presenting a rotated one ends the whole session. */
  async refresh(
    ctx: StoreContext,
    raw: string,
    meta: ClientMeta,
  ): Promise<CustomerTokenPairDto> {
    const token = await this.prisma.customerSession.findUnique({
      where: { tokenHash: sha256(raw) },
      select: {
        id: true,
        familyId: true,
        revokedAt: true,
        replacedById: true,
        expiresAt: true,
        customer: {
          select: { id: true, email: true, websiteId: true, status: true },
        },
      },
    });
    if (!token || token.customer.websiteId !== ctx.websiteId)
      throw new UnauthorizedException('Invalid refresh token');
    const c = token.customer;
    if (token.replacedById || token.revokedAt) {
      if (token.replacedById) {
        const families = await this.bus.write({
          before: new BeforeWriteEvent(
            CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
            'revoke-family',
            c.id,
            customerActor(c),
          ),
          work: async (tx, after) => {
            const f = await this.sessions.revokeFamilies(tx, {
              familyId: token.familyId,
            });
            after.add(
              new EntityEvent(
                CUSTOMER_EVENTS.TOKEN_REUSE_DETECTED,
                customerActor(c),
                'customer',
                c.id,
                { sessionId: token.familyId },
              ),
            );
            return f;
          },
        });
        await this.sessions.markRevoked(families);
      }
      throw new UnauthorizedException('Refresh token is no longer valid');
    }
    if (token.expiresAt < new Date() || c.status !== 'ACTIVE')
      throw new UnauthorizedException('Session expired; sign in again');
    return this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'refresh',
        c.id,
        customerActor(c),
      ),
      work: async (tx) => {
        const issued = await this.sessions.issue(tx, c, meta, token.familyId);
        // Compare-and-set: of two concurrent refreshes with one token, only one wins.
        const { count } = await tx.customerSession.updateMany({
          where: { id: token.id, replacedById: null, revokedAt: null },
          data: { replacedById: issued.sessionRowId, revokedAt: new Date() },
        });
        if (!count)
          throw new UnauthorizedException('Refresh token is no longer valid');
        return issued.pair;
      },
    });
  }

  async logout(
    customer: StorefrontCustomer,
    everywhere: boolean,
  ): Promise<void> {
    const families = await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'logout',
        customer.id,
        customerActor(customer),
      ),
      work: async (tx, after) => {
        const f = await this.sessions.revokeFamilies(
          tx,
          everywhere
            ? { customerId: customer.id }
            : { familyId: customer.sessionId },
        );
        after.add(
          new ProjectionEvent(CUSTOMER_EVENTS.LOGGED_OUT, {
            customerId: customer.id,
            everywhere,
          }),
        );
        return f;
      },
    });
    await this.sessions.markRevoked([...families, customer.sessionId]);
  }

  /** Changing the password ends every session, including this one. */
  async changePassword(
    customer: StorefrontCustomer,
    current: string,
    next: string,
  ): Promise<void> {
    const c = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { passwordHash: true, email: true },
    });
    if (!(await verifyPassword(current, c.passwordHash)))
      throw new UnauthorizedException('Current password is wrong');
    const problems = passwordProblems(next, c.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `newPassword ${p}`));
    if (await verifyPassword(next, c.passwordHash))
      throw new BadRequestException([
        'newPassword must differ from the current one',
      ]);
    const passwordHash = await hashPassword(next);
    const families = await this.bus.write({
      before: new BeforeWriteEvent(
        CUSTOMER_EVENTS.BEFORE_SESSION_WRITE,
        'change-password',
        customer.id,
        customerActor(customer),
      ),
      work: async (tx, after) => {
        await tx.customer.update({
          where: { id: customer.id },
          data: { passwordHash, passwordChangedAt: new Date() },
        });
        const f = await this.sessions.revokeFamilies(tx, {
          customerId: customer.id,
        });
        after.add(
          new EntityEvent(
            CUSTOMER_EVENTS.PASSWORD_CHANGED,
            customerActor(customer),
            'customer',
            customer.id,
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked([...families, customer.sessionId]);
  }
}
