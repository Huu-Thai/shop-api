import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { formatMoney } from '../pricing/money.js';
import type { StorefrontCustomer } from '../stores/context/store-context.js';
import { StoresQuery } from '../stores/stores.query.js';
import type {
  AccountDto,
  AccountListItemDto,
  ListAccountsQueryDto,
  ListTransactionsQueryDto,
  StorefrontLoyaltyDto,
  TransactionDto,
} from './dto/loyalty.dto.js';
import { nextTier } from './ledger.js';
import { accountView } from './loyalty.service.js';

const DAY = 86_400_000;

const ACCOUNT_SELECT = {
  id: true,
  customerId: true,
  programId: true,
  balance: true,
  lifetimePoints: true,
  createdAt: true,
  tier: {
    select: {
      id: true,
      code: true,
      name: true,
      thresholdPoints: true,
      multiplierBp: true,
    },
  },
} as const satisfies Prisma.LoyaltyAccountSelect;

const TX_SELECT = {
  id: true,
  type: true,
  points: true,
  remaining: true,
  expiresAt: true,
  orderRef: true,
  note: true,
  createdAt: true,
} as const;

/** Read side of loyalty: back-office account views and the shopper's own summary. */
@Injectable()
export class LoyaltyQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
  ) {}

  async accounts(
    q: ListAccountsQueryDto,
  ): Promise<Paginated<AccountListItemDto>> {
    const term = q.search?.trim();
    const contains = (v: string) => ({
      contains: v,
      mode: 'insensitive' as const,
    });
    const where: Prisma.LoyaltyAccountWhereInput = {
      ...(q.websiteId ? { program: { websiteId: q.websiteId } } : {}),
      ...(q.tierCode ? { tier: { code: q.tierCode } } : {}),
      ...(term
        ? {
            customer: {
              OR: [
                { email: contains(term) },
                { firstName: contains(term) },
                { lastName: contains(term) },
              ],
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.loyaltyAccount.findMany({
        where,
        select: {
          ...ACCOUNT_SELECT,
          customer: {
            select: { email: true, firstName: true, lastName: true },
          },
        },
        orderBy: [{ balance: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.loyaltyAccount.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  async accountOf(customerId: string): Promise<AccountDto> {
    const a = await this.prisma.loyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true },
    });
    if (!a)
      throw new NotFoundException(
        `Customer ${customerId} has no loyalty account`,
      );
    return accountView(this.prisma, a.id);
  }

  async transactions(
    customerId: string,
    q: ListTransactionsQueryDto,
  ): Promise<Paginated<TransactionDto>> {
    const where: Prisma.LoyaltyTransactionWhereInput = {
      account: { customerId },
      type: q.type,
    };
    const [rows, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({
        where,
        select: TX_SELECT,
        orderBy: [{ createdAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.loyaltyTransaction.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  /** The shopper's balance, its worth, tier progress, points expiring soon and recent activity. */
  async summary(
    customer: StorefrontCustomer,
    localeCode: string,
    now = new Date(),
  ): Promise<StorefrontLoyaltyDto | undefined> {
    const a = await this.prisma.loyaltyAccount.findUnique({
      where: { customerId: customer.id },
      select: {
        id: true,
        balance: true,
        tierId: true,
        program: {
          select: {
            name: true,
            currencyCode: true,
            spendPerPoint: true,
            pointValue: true,
            minRedeemPoints: true,
            tierWindowDays: true,
            tiers: {
              select: {
                id: true,
                code: true,
                name: true,
                thresholdPoints: true,
                multiplierBp: true,
              },
            },
          },
        },
      },
    });
    if (!a) return undefined;
    const p = a.program;
    const since = new Date(now.getTime() - p.tierWindowDays * DAY);
    const soon = new Date(now.getTime() + 30 * DAY);
    const [windowRow, expiring, recent, snap] = await Promise.all([
      this.prisma.loyaltyTransaction.aggregate({
        where: {
          accountId: a.id,
          createdAt: { gte: since },
          OR: [{ type: 'EARN' }, { type: 'REVERSE', points: { lt: 0 } }],
        },
        _sum: { points: true },
      }),
      this.prisma.loyaltyTransaction.findMany({
        where: {
          accountId: a.id,
          remaining: { gt: 0 },
          expiresAt: { gt: now },
        },
        select: { remaining: true, expiresAt: true },
        orderBy: { expiresAt: 'asc' },
      }),
      this.prisma.loyaltyTransaction.findMany({
        where: { accountId: a.id },
        select: {
          type: true,
          points: true,
          orderRef: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      this.stores.snapshot(),
    ]);
    const minor = snap.currencies.get(p.currencyCode)?.minorUnits ?? 2;
    const tier = p.tiers.find((t) => t.id === a.tierId) ?? null;
    const windowPoints = windowRow._sum.points ?? 0;
    const next = nextTier(p.tiers, windowPoints);
    const view = (t: { code: string; name: string; multiplierBp: number }) => ({
      code: t.code,
      name: t.name,
      multiplier: t.multiplierBp / 10_000,
    });
    return {
      programName: p.name,
      balance: a.balance,
      balanceValue: formatMoney(
        BigInt(a.balance) * p.pointValue,
        p.currencyCode,
        minor,
        localeCode,
      ),
      currencyCode: p.currencyCode,
      minRedeemPoints: p.minRedeemPoints,
      pointsPerUnit: Number(10n ** BigInt(minor)) / Number(p.spendPerPoint),
      tier: tier ? view(tier) : null,
      nextTier:
        next && next.id !== tier?.id
          ? { ...view(next), pointsNeeded: next.pointsNeeded }
          : null,
      expiringSoon: expiring
        .filter((e) => e.expiresAt! <= soon)
        .reduce((s, e) => s + e.remaining, 0),
      nextExpiryAt: expiring[0]?.expiresAt ?? null,
      recent,
    };
  }

  /** What a customer may redeem now (checkout), or undefined without an active program account. */
  async redemptionTerms(customerId: string): Promise<
    | {
        balance: number;
        pointValue: bigint;
        currencyCode: string;
        minRedeemPoints: number;
        maxRedeemPercent: number;
      }
    | undefined
  > {
    const a = await this.prisma.loyaltyAccount.findUnique({
      where: { customerId },
      select: {
        balance: true,
        program: {
          select: {
            isActive: true,
            pointValue: true,
            currencyCode: true,
            minRedeemPoints: true,
            maxRedeemPercent: true,
          },
        },
      },
    });
    if (!a || !a.program.isActive) return undefined;
    const { isActive: _a, ...p } = a.program;
    return { balance: a.balance, ...p };
  }
}
