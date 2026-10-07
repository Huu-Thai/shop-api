import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type ActorRef, SYSTEM_ACTOR } from '../../common/auth/principal.js';
import type { AfterEvents } from '../../common/events/base.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { LoyaltyTransactionType } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import type {
  AccountDto,
  AdjustDto,
  EarnDto,
  OperationResultDto,
  RedeemPointsDto,
  ReverseDto,
  TransactionDto,
} from './dto/loyalty.dto.js';
import {
  allocate,
  earnedPoints,
  reversalPoints,
  type TierRule,
  tierFor,
} from './ledger.js';
import {
  LOYALTY_EVENTS,
  type LoyaltyEventData,
  type TierChangedData,
} from './loyalty.events.js';

const DAY = 86_400_000;

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

interface Program {
  id: string;
  currencyCode: string;
  spendPerPoint: bigint;
  pointValue: bigint;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  expiryDays: number | null;
  tierWindowDays: number;
  isActive: boolean;
  tiers: TierRule[];
}

interface Locked {
  id: string;
  customerId: string;
  balance: number;
  lifetimePoints: number;
  tierId: string | null;
  program: Program;
}

/**
 * The points ledger (PLAN.md §9.8). Every operation locks the account row, appends transactions,
 * moves `remaining` on credit rows FIFO by expiry, and keeps `balance` = Σ remaining in the same
 * transaction. Debits record the credits they consumed (`loyalty_allocations`), so cancelling an
 * order gives back exactly the points it used. Earning and redeeming are idempotent per order.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  /** Opens the customer's account if their website has a program (idempotent). */
  async openAccount(customerId: string): Promise<boolean> {
    return this.bus.write({
      before: this.before('open', customerId, SYSTEM_ACTOR),
      work: async (tx, after) => {
        const program = await this.programOf(tx, customerId, false);
        if (!program) return false;
        const created = await tx.$executeRaw`
          INSERT INTO loyalty_accounts (program_id, customer_id, updated_at)
          VALUES (${program.id}::uuid, ${customerId}::uuid, now())
          ON CONFLICT (customer_id) DO NOTHING`;
        if (created)
          after.add(
            new EntityEvent(
              LOYALTY_EVENTS.ACCOUNT_OPENED,
              SYSTEM_ACTOR,
              'customer',
              customerId,
              {
                programId: program.id,
              },
            ),
          );
        return created > 0;
      },
    });
  }

  /** Points for a paid order: floor(amount / spend per point) × the tier multiplier. */
  async earn(
    customerId: string,
    dto: EarnDto,
    actor: ActorRef,
    now = new Date(),
  ): Promise<OperationResultDto> {
    return this.bus.write({
      before: this.before('earn', customerId, actor, dto),
      work: async (tx, after) => {
        const a = await this.lock(tx, customerId, true);
        if (!a.program.isActive)
          throw new ConflictException('The loyalty program is paused');
        if (dto.currencyCode !== a.program.currencyCode)
          throw new BadRequestException(
            `Points are earned on ${a.program.currencyCode} amounts`,
          );
        const existing = await tx.loyaltyTransaction.findFirst({
          where: { accountId: a.id, type: 'EARN', orderRef: dto.orderRef },
          select: TX_SELECT,
        });
        if (existing) return this.result(tx, a.id, []);
        const tier = a.program.tiers.find((t) => t.id === a.tierId);
        const points = earnedPoints(
          BigInt(dto.amount),
          a.program.spendPerPoint,
          tier?.multiplierBp ?? 10_000,
        );
        if (points <= 0) return this.result(tx, a.id, []);
        const t = await tx.loyaltyTransaction.create({
          data: {
            accountId: a.id,
            type: 'EARN',
            points,
            remaining: points,
            orderRef: dto.orderRef,
            amount: BigInt(dto.amount),
            currencyCode: dto.currencyCode,
            expiresAt: a.program.expiryDays
              ? new Date(now.getTime() + a.program.expiryDays * DAY)
              : null,
            actorLabel: actor.label.slice(0, 255),
          },
          select: TX_SELECT,
        });
        await this.move(tx, a, points, points);
        await this.evaluateTier(tx, a, after, now);
        this.announce(
          after,
          LOYALTY_EVENTS.EARNED,
          actor,
          a,
          points,
          dto.orderRef,
        );
        return this.result(tx, a.id, [t]);
      },
    });
  }

  /** Spends points on an order (FIFO by expiry). Returns the discount they pay. */
  async redeem(
    customerId: string,
    dto: RedeemPointsDto,
    actor: ActorRef,
    now = new Date(),
  ): Promise<OperationResultDto> {
    return this.bus.write({
      before: this.before('redeem', customerId, actor, dto),
      work: async (tx, after) => {
        const a = await this.lock(tx, customerId, false);
        const p = a.program;
        const existing = await tx.loyaltyTransaction.findFirst({
          where: { accountId: a.id, type: 'REDEEM', orderRef: dto.orderRef },
          select: TX_SELECT,
        });
        if (existing)
          return {
            ...(await this.result(tx, a.id, [])),
            value: (BigInt(-existing.points) * p.pointValue).toString(),
          };
        if (!p.isActive)
          throw new ConflictException('The loyalty program is paused');
        if (dto.points < p.minRedeemPoints)
          throw new BadRequestException(
            `At least ${p.minRedeemPoints} points must be redeemed at once`,
          );
        const value = BigInt(dto.points) * p.pointValue;
        if (
          dto.orderAmount !== undefined &&
          value * 100n > BigInt(dto.orderAmount) * BigInt(p.maxRedeemPercent)
        )
          throw new BadRequestException(
            `Points may pay at most ${p.maxRedeemPercent}% of an order`,
          );
        if (dto.points > a.balance)
          throw new ConflictException(`Only ${a.balance} points are available`);
        const t = await this.debit(tx, a, 'REDEEM', dto.points, now, {
          orderRef: dto.orderRef,
          actor,
        });
        this.announce(
          after,
          LOYALTY_EVENTS.REDEEMED,
          actor,
          a,
          -dto.points,
          dto.orderRef,
        );
        return {
          ...(await this.result(tx, a.id, [t])),
          value: value.toString(),
        };
      },
    });
  }

  /**
   * A refund or cancellation: takes back the points the order earned (in proportion to `amount`,
   * or all of them), and — for a cancellation — returns the points it redeemed to the credits they
   * came from (unless those have expired meanwhile). Repeating it never reverses more than once.
   */
  async reverse(
    customerId: string,
    dto: ReverseDto,
    actor: ActorRef,
    now = new Date(),
  ): Promise<OperationResultDto> {
    return this.bus.write({
      before: this.before('reverse', customerId, actor, dto),
      work: async (tx, after) => {
        const a = await this.lock(tx, customerId, false);
        const written: TransactionDto[] = [];
        const reversals = await tx.loyaltyTransaction.findMany({
          where: { accountId: a.id, type: 'REVERSE', orderRef: dto.orderRef },
          select: { points: true },
        });

        // A cancellation first gives back what the order redeemed (to the credits it came from),
        // so clawing back its earned points below can draw on them.
        const restore = dto.restoreRedeemed ?? dto.amount === undefined;
        const restoredBefore = reversals.some((r) => r.points > 0);
        const redeem =
          restore && !restoredBefore
            ? await tx.loyaltyTransaction.findFirst({
                where: {
                  accountId: a.id,
                  type: 'REDEEM',
                  orderRef: dto.orderRef,
                },
                select: {
                  debits: {
                    select: {
                      points: true,
                      credit: { select: { id: true, expiresAt: true } },
                    },
                  },
                },
              })
            : null;
        if (redeem) {
          let restored = 0;
          for (const d of redeem.debits) {
            if (d.credit.expiresAt && d.credit.expiresAt <= now) continue;
            await tx.loyaltyTransaction.update({
              where: { id: d.credit.id },
              data: { remaining: { increment: d.points } },
            });
            restored += d.points;
          }
          const lost =
            redeem.debits.reduce((s, d) => s + d.points, 0) - restored;
          if (restored > 0) {
            written.push(
              await tx.loyaltyTransaction.create({
                data: {
                  accountId: a.id,
                  type: 'REVERSE',
                  points: restored,
                  orderRef: dto.orderRef,
                  note: lost
                    ? `${lost} redeemed points had expired and were not returned`
                    : null,
                  actorLabel: actor.label.slice(0, 255),
                },
                select: TX_SELECT,
              }),
            );
            await this.move(tx, a, restored, 0);
          }
        }

        const earn = await tx.loyaltyTransaction.findFirst({
          where: { accountId: a.id, type: 'EARN', orderRef: dto.orderRef },
          select: { id: true, points: true, amount: true },
        });
        if (earn) {
          const already = -reversals
            .filter((r) => r.points < 0)
            .reduce((s, r) => s + r.points, 0);
          const target = reversalPoints(
            earn.points,
            earn.amount,
            dto.amount === undefined ? undefined : BigInt(dto.amount),
          );
          const want = Math.min(target, earn.points - already);
          // Points already spent elsewhere can't be clawed back below zero.
          const points = Math.min(want, a.balance);
          if (points > 0)
            written.push(
              await this.debit(tx, a, 'REVERSE', points, now, {
                orderRef: dto.orderRef,
                actor,
                preferCreditId: earn.id,
                note:
                  points < want
                    ? `${want - points} points were already spent`
                    : undefined,
                lifetime: true,
              }),
            );
        }
        if (
          !earn &&
          !reversals.length &&
          !(await tx.loyaltyTransaction.count({
            where: { accountId: a.id, type: 'REDEEM', orderRef: dto.orderRef },
          }))
        )
          throw new NotFoundException(
            `No points were earned or redeemed for order ${dto.orderRef}`,
          );
        if (written.length) {
          await this.evaluateTier(tx, a, after, now);
          this.announce(
            after,
            LOYALTY_EVENTS.REVERSED,
            actor,
            a,
            written.reduce((s, t) => s + t.points, 0),
            dto.orderRef,
          );
        }
        return this.result(tx, a.id, written);
      },
    });
  }

  /** Manual correction by staff (credits expire like earned points; debits go FIFO). */
  async adjust(
    customerId: string,
    dto: AdjustDto,
    actor: ActorRef,
    now = new Date(),
  ): Promise<OperationResultDto> {
    return this.bus.write({
      before: this.before('adjust', customerId, actor, dto),
      work: async (tx, after) => {
        const a = await this.lock(tx, customerId, true);
        let t: TransactionDto;
        if (dto.points > 0) {
          t = await tx.loyaltyTransaction.create({
            data: {
              accountId: a.id,
              type: 'ADJUST',
              points: dto.points,
              remaining: dto.points,
              note: dto.note,
              expiresAt: a.program.expiryDays
                ? new Date(now.getTime() + a.program.expiryDays * DAY)
                : null,
              actorLabel: actor.label.slice(0, 255),
            },
            select: TX_SELECT,
          });
          await this.move(tx, a, dto.points, 0);
        } else {
          if (-dto.points > a.balance)
            throw new ConflictException(
              `Only ${a.balance} points are available`,
            );
          t = await this.debit(tx, a, 'ADJUST', -dto.points, now, {
            actor,
            note: dto.note,
          });
        }
        this.announce(
          after,
          LOYALTY_EVENTS.ADJUSTED,
          actor,
          a,
          dto.points,
          null,
          dto.note,
        );
        return this.result(tx, a.id, [t]);
      },
    });
  }

  /** Daily job: expires credits past their date (one EXPIRE per credit). Returns points expired. */
  async expireDue(now = new Date(), batch = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const due = await this.prisma.loyaltyTransaction.findMany({
        where: { remaining: { gt: 0 }, expiresAt: { lte: now } },
        select: { accountId: true },
        distinct: ['accountId'],
        take: batch,
      });
      if (!due.length) break;
      for (const { accountId } of due)
        total += await this.expireAccount(accountId, now);
      if (due.length < batch) break;
    }
    if (total) this.logger.log(`Expired ${total} loyalty points`);
    return total;
  }

  private expireAccount(accountId: string, now: Date): Promise<number> {
    return this.bus.write({
      before: this.before('expire', accountId, SYSTEM_ACTOR),
      work: async (tx, after) => {
        const [acc] = await tx.$queryRaw<{ customerId: string }[]>`
          SELECT customer_id AS "customerId" FROM loyalty_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
        if (!acc) return 0;
        const a = await this.lock(tx, acc.customerId, false);
        const credits = await tx.loyaltyTransaction.findMany({
          where: { accountId, remaining: { gt: 0 }, expiresAt: { lte: now } },
          select: { id: true, remaining: true },
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
        });
        let expired = 0;
        for (const c of credits) {
          const t = await tx.loyaltyTransaction.create({
            data: {
              accountId,
              type: 'EXPIRE',
              points: -c.remaining,
              actorLabel: 'system',
            },
            select: { id: true },
          });
          await tx.loyaltyAllocation.create({
            data: { debitId: t.id, creditId: c.id, points: c.remaining },
          });
          await tx.loyaltyTransaction.update({
            where: { id: c.id },
            data: { remaining: 0 },
          });
          expired += c.remaining;
        }
        if (expired) {
          await this.move(tx, a, -expired, 0);
          this.announce(
            after,
            LOYALTY_EVENTS.EXPIRED,
            SYSTEM_ACTOR,
            a,
            -expired,
            null,
          );
        }
        return expired;
      },
    });
  }

  /** Nightly job: tiers follow the rolling window (downgrades included). Returns accounts changed. */
  async evaluateTiers(now = new Date(), batch = 500): Promise<number> {
    let changed = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.loyaltyAccount.findMany({
        where: { program: { tiers: { some: {} } } },
        select: { id: true, customerId: true },
        orderBy: { id: 'asc' },
        take: batch,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const r of rows)
        if (
          await this.bus.write({
            before: this.before('evaluate-tier', r.customerId, SYSTEM_ACTOR),
            work: async (tx, after) => {
              const a = await this.lock(tx, r.customerId, false);
              return this.evaluateTier(tx, a, after, now);
            },
          })
        )
          changed++;
      if (rows.length < batch) break;
      cursor = rows[rows.length - 1].id;
    }
    return changed;
  }

  // ─── internals ───

  private before(action: string, id: string, actor: ActorRef, input?: unknown) {
    return new BeforeWriteEvent(
      LOYALTY_EVENTS.BEFORE_WRITE,
      action,
      id,
      actor,
      input,
    );
  }

  private async programOf(
    tx: PrismaTransaction,
    customerId: string,
    required: boolean,
  ): Promise<Program | null> {
    const c = await tx.customer.findUnique({
      where: { id: customerId },
      select: { websiteId: true },
    });
    if (!c) throw new NotFoundException(`Customer ${customerId} not found`);
    const p = await tx.loyaltyProgram.findUnique({
      where: { websiteId: c.websiteId },
      select: {
        id: true,
        currencyCode: true,
        spendPerPoint: true,
        pointValue: true,
        minRedeemPoints: true,
        maxRedeemPercent: true,
        expiryDays: true,
        tierWindowDays: true,
        isActive: true,
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
    });
    if (!p && required)
      throw new ConflictException(
        "The customer's website has no loyalty program",
      );
    return p;
  }

  /** Locks (and if allowed, opens) the customer's account. */
  private async lock(
    tx: PrismaTransaction,
    customerId: string,
    open: boolean,
  ): Promise<Locked> {
    const program = (await this.programOf(tx, customerId, true))!;
    if (open)
      await tx.$executeRaw`
        INSERT INTO loyalty_accounts (program_id, customer_id, updated_at)
        VALUES (${program.id}::uuid, ${customerId}::uuid, now())
        ON CONFLICT (customer_id) DO NOTHING`;
    const [row] = await tx.$queryRaw<
      {
        id: string;
        balance: number;
        lifetimePoints: number;
        tierId: string | null;
      }[]
    >`
      SELECT id, balance, lifetime_points AS "lifetimePoints", tier_id AS "tierId"
        FROM loyalty_accounts WHERE customer_id = ${customerId}::uuid FOR UPDATE`;
    if (!row)
      throw new NotFoundException('The customer has no loyalty account yet');
    return { ...row, customerId, program };
  }

  /** Writes a debit consuming credits FIFO (a preferred credit first). Caller checked the balance. */
  private async debit(
    tx: PrismaTransaction,
    a: Locked,
    type: LoyaltyTransactionType,
    points: number,
    now: Date,
    opts: {
      orderRef?: string;
      actor: ActorRef;
      note?: string;
      preferCreditId?: string;
      lifetime?: boolean;
    },
  ): Promise<TransactionDto> {
    const credits = await tx.loyaltyTransaction.findMany({
      where: {
        accountId: a.id,
        remaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, remaining: true },
      orderBy: [
        { expiresAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    const ordered = opts.preferCreditId
      ? [
          ...credits.filter((c) => c.id === opts.preferCreditId),
          ...credits.filter((c) => c.id !== opts.preferCreditId),
        ]
      : credits;
    const { allocations, shortfall } = allocate(ordered, points);
    if (shortfall)
      throw new ConflictException(
        `Only ${points - shortfall} points are available`,
      );
    const t = await tx.loyaltyTransaction.create({
      data: {
        accountId: a.id,
        type,
        points: -points,
        orderRef: opts.orderRef ?? null,
        note: opts.note ?? null,
        actorLabel: opts.actor.label.slice(0, 255),
      },
      select: TX_SELECT,
    });
    for (const al of allocations) {
      await tx.loyaltyAllocation.create({
        data: { debitId: t.id, creditId: al.creditId, points: al.points },
      });
      await tx.loyaltyTransaction.update({
        where: { id: al.creditId },
        data: { remaining: { decrement: al.points } },
      });
    }
    await this.move(tx, a, -points, opts.lifetime ? -points : 0);
    return t;
  }

  /** Applies balance / lifetime deltas to the locked account (and the in-memory copy). */
  private async move(
    tx: PrismaTransaction,
    a: Locked,
    balance: number,
    lifetime: number,
  ): Promise<void> {
    a.balance += balance;
    a.lifetimePoints = Math.max(a.lifetimePoints + lifetime, 0);
    await tx.loyaltyAccount.update({
      where: { id: a.id },
      data: { balance: a.balance, lifetimePoints: a.lifetimePoints },
    });
  }

  /** Sets the tier from points earned in the rolling window; true when it changed. */
  private async evaluateTier(
    tx: PrismaTransaction,
    a: Locked,
    after: AfterEvents,
    now: Date,
  ): Promise<boolean> {
    if (!a.program.tiers.length) return false;
    const since = new Date(now.getTime() - a.program.tierWindowDays * DAY);
    const [row] = await tx.$queryRaw<{ points: bigint | null }[]>`
      SELECT SUM(points) AS points FROM loyalty_transactions
       WHERE account_id = ${a.id}::uuid AND created_at >= ${since}
         AND (type = 'EARN' OR (type = 'REVERSE' AND points < 0))`;
    const windowPoints = Number(row?.points ?? 0n);
    const tier = tierFor(a.program.tiers, windowPoints);
    if ((tier?.id ?? null) === a.tierId) return false;
    const from = a.program.tiers.find((t) => t.id === a.tierId)?.code ?? null;
    await tx.loyaltyAccount.update({
      where: { id: a.id },
      data: { tierId: tier?.id ?? null },
    });
    a.tierId = tier?.id ?? null;
    after.add(
      new EntityEvent<TierChangedData>(
        LOYALTY_EVENTS.TIER_CHANGED,
        SYSTEM_ACTOR,
        'customer',
        a.customerId,
        { tier: { from, to: tier?.code ?? null }, windowPoints },
        {
          accountId: a.id,
          customerId: a.customerId,
          from,
          to: tier?.code ?? null,
        },
      ),
    );
    return true;
  }

  private announce(
    after: AfterEvents,
    name: string,
    actor: ActorRef,
    a: Locked,
    points: number,
    orderRef: string | null,
    note?: string,
  ): void {
    after.add(
      new EntityEvent<LoyaltyEventData>(
        name,
        actor,
        'customer',
        a.customerId,
        {
          points,
          balance: a.balance,
          ...(orderRef ? { orderRef } : {}),
          ...(note ? { note } : {}),
        },
        {
          accountId: a.id,
          customerId: a.customerId,
          points,
          balance: a.balance,
          orderRef,
        },
      ),
    );
  }

  private async result(
    tx: PrismaTransaction,
    accountId: string,
    transactions: TransactionDto[],
  ): Promise<OperationResultDto> {
    return { account: await accountView(tx, accountId), transactions };
  }
}

export async function accountView(
  db: Pick<PrismaTransaction, 'loyaltyAccount'>,
  accountId: string,
): Promise<AccountDto> {
  const a = await db.loyaltyAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
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
    },
  });
  return a;
}
