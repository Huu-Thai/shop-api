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
import type { Principal } from '../../../common/auth/principal.js';
import { actorOf } from '../../../common/auth/principal.js';
import { TransactionalEventBus } from '../../../common/events/transactional-event-bus.js';
import type { AppConfig } from '../../../config/configuration.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  AdminUserBeforeWriteEvent,
  AdminUserPasswordChangedEvent,
} from '../users/events/admin-user.events.js';
import type { MeDto, TokenPairDto } from './dto/auth.dto.js';
import {
  AccountLockedEvent,
  AuthBeforeSessionWriteEvent,
  LoggedInEvent,
  LoggedOutEvent,
  LoginFailedEvent,
  TokenReuseDetectedEvent,
} from './events/auth.events.js';
import { type ClientMeta, SessionService } from './session.service.js';

const INVALID = 'Invalid e-mail or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get settings() {
    return this.config.get('auth', { infer: true });
  }

  /**
   * One generic error for unknown e-mail, wrong password, disabled or locked account, with the
   * same scrypt work in every case — no account-enumeration oracle.
   */
  async login(
    email: string,
    password: string,
    meta: ClientMeta,
  ): Promise<TokenPairDto> {
    const user = await this.prisma.adminUser.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        failedLogins: true,
        lockedUntil: true,
      },
    });
    const ok = await verifyPassword(
      password,
      user?.passwordHash ?? (await dummyHash()),
    );
    if (!user) throw new UnauthorizedException(INVALID);
    const locked = user.lockedUntil !== null && user.lockedUntil > new Date();
    if (!ok || locked || user.status !== 'ACTIVE') {
      if (!ok && !locked)
        await this.recordFailure(user.id, user.email, user.failedLogins);
      throw new UnauthorizedException(INVALID);
    }
    return this.bus.write({
      before: new AuthBeforeSessionWriteEvent('login', user.id),
      work: async (tx, after) => {
        await tx.adminUser.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        const { pair, familyId } = await this.sessions.issue(tx, user.id, meta);
        after.add(new LoggedInEvent(user.id, user.email, familyId));
        return pair;
      },
    });
  }

  private async recordFailure(
    id: string,
    email: string,
    previous: number,
  ): Promise<void> {
    const { maxFailedLogins, lockoutMinutes } = this.settings;
    await this.bus.write({
      before: new AuthBeforeSessionWriteEvent('login-failed', id),
      work: async (tx, after) => {
        // Atomic increment: concurrent guesses can't slip past the threshold.
        const row = await tx.adminUser.update({
          where: { id },
          data: { failedLogins: { increment: 1 } },
          select: { failedLogins: true },
        });
        after.add(
          new LoginFailedEvent(id, email, row.failedLogins ?? previous + 1),
        );
        if (row.failedLogins >= maxFailedLogins) {
          const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000);
          await tx.adminUser.update({
            where: { id },
            data: { lockedUntil, failedLogins: 0 },
          });
          after.add(new AccountLockedEvent(id, email, lockedUntil));
        }
      },
    });
  }

  /**
   * Rotation: each refresh token works once. Presenting an already-rotated token means it was
   * copied — the whole session (family) is revoked and the caller must sign in again.
   */
  async refresh(raw: string, meta: ClientMeta): Promise<TokenPairDto> {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(raw) },
      select: {
        id: true,
        familyId: true,
        revokedAt: true,
        replacedById: true,
        expiresAt: true,
        adminUser: {
          select: { id: true, email: true, status: true, deletedAt: true },
        },
      },
    });
    if (!token) throw new UnauthorizedException('Invalid refresh token');
    const user = token.adminUser;

    if (token.replacedById || token.revokedAt) {
      if (token.replacedById) {
        const families = await this.bus.write({
          before: new AuthBeforeSessionWriteEvent('revoke-family', user.id),
          work: async (tx, after) => {
            const f = await this.sessions.revokeFamilies(tx, {
              familyId: token.familyId,
            });
            after.add(
              new TokenReuseDetectedEvent(user.id, user.email, token.familyId),
            );
            return f;
          },
        });
        await this.sessions.markRevoked(families);
      }
      throw new UnauthorizedException('Refresh token is no longer valid');
    }
    if (
      token.expiresAt < new Date() ||
      user.status !== 'ACTIVE' ||
      user.deletedAt
    )
      throw new UnauthorizedException('Session expired; sign in again');

    return this.bus.write({
      before: new AuthBeforeSessionWriteEvent('refresh', user.id),
      work: async (tx) => {
        const issued = await this.sessions.issue(
          tx,
          user.id,
          meta,
          token.familyId,
        );
        // Compare-and-set: two concurrent refreshes with the same token — only one wins.
        const { count } = await tx.refreshToken.updateMany({
          where: { id: token.id, replacedById: null, revokedAt: null },
          data: { replacedById: issued.refreshTokenId, revokedAt: new Date() },
        });
        if (!count)
          throw new UnauthorizedException('Refresh token is no longer valid');
        return issued.pair;
      },
    });
  }

  async logout(principal: Principal, everywhere: boolean): Promise<void> {
    const families = await this.bus.write({
      before: new AuthBeforeSessionWriteEvent('logout', principal.id),
      work: async (tx, after) => {
        const f = await this.sessions.revokeFamilies(
          tx,
          everywhere
            ? { adminUserId: principal.id }
            : { familyId: principal.sessionId! },
        );
        after.add(
          new LoggedOutEvent(
            actorOf(principal),
            principal.id,
            principal.sessionId ?? '',
            everywhere ? 'all' : 'session',
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked([
      ...new Set([
        ...families,
        ...(principal.sessionId ? [principal.sessionId] : []),
      ]),
    ]);
  }

  async me(principal: Principal): Promise<MeDto> {
    const user = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: principal.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        lastLoginAt: true,
        roles: { select: { role: { select: { code: true } } } },
      },
    });
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      lastLoginAt: user.lastLoginAt,
      roles: user.roles.map((r) => r.role.code),
      permissions: principal.permissions,
    };
  }

  /** Changing your own password ends every session (sign in again with the new one). */
  async changePassword(
    principal: Principal,
    current: string,
    next: string,
  ): Promise<void> {
    const user = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: principal.id },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!(await verifyPassword(current, user.passwordHash)))
      throw new UnauthorizedException('Current password is wrong');
    const problems = passwordProblems(next, user.email);
    if (problems.length)
      throw new BadRequestException(problems.map((p) => `newPassword ${p}`));
    if (await verifyPassword(next, user.passwordHash))
      throw new BadRequestException([
        'newPassword must differ from the current one',
      ]);
    const passwordHash = await hashPassword(next);
    const families = await this.bus.write({
      before: new AdminUserBeforeWriteEvent(
        'password',
        user.id,
        actorOf(principal),
      ),
      work: async (tx, after) => {
        await tx.adminUser.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: new Date() },
        });
        const f = await this.sessions.revokeFamilies(tx, {
          adminUserId: user.id,
        });
        after.add(
          new AdminUserPasswordChangedEvent(
            actorOf(principal),
            user.id,
            'self',
          ),
        );
        return f;
      },
    });
    await this.sessions.markRevoked(families);
  }
}
