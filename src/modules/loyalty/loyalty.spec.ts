import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import {
  allocate,
  earnedPoints,
  nextTier,
  reversalPoints,
  tierFor,
} from './ledger.js';
import {
  AccountLoyaltyController,
  LoyaltyAdminController,
} from './loyalty.controllers.js';
import { LoyaltyListener } from './loyalty.listener.js';
import { LoyaltyProcessor, LoyaltyScheduler } from './loyalty.processor.js';
import { LoyaltyProgramsService } from './loyalty-programs.service.js';
import { LoyaltyQuery } from './loyalty.query.js';
import { LoyaltyService } from './loyalty.service.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const DAY = 86_400_000;
const tiers = [
  {
    id: 't2',
    code: 'gold',
    name: 'Gold',
    thresholdPoints: 500,
    multiplierBp: 15000,
  },
  {
    id: 't1',
    code: 'silver',
    name: 'Silver',
    thresholdPoints: 100,
    multiplierBp: 12000,
  },
];

describe('ledger arithmetic', () => {
  it('allocates FIFO and reports shortfalls', () => {
    expect(
      allocate(
        [
          { id: 'a', remaining: 3 },
          { id: 'b', remaining: 0 },
          { id: 'c', remaining: 5 },
        ],
        6,
      ),
    ).toEqual({
      allocations: [
        { creditId: 'a', points: 3 },
        { creditId: 'c', points: 3 },
      ],
      shortfall: 0,
    });
    expect(allocate([{ id: 'a', remaining: 2 }], 5).shortfall).toBe(3);
  });

  it('earns, reverses proportionally and picks tiers', () => {
    expect(earnedPoints(12_999n, 100n, 10_000)).toBe(129);
    expect(earnedPoints(12_999n, 100n, 15_000)).toBe(193);
    expect(earnedPoints(0n, 100n, 10_000)).toBe(0);
    expect(reversalPoints(600, 60_000n, 20_000n)).toBe(200);
    expect(reversalPoints(600, 60_000n, undefined)).toBe(600);
    expect(reversalPoints(600, 60_000n, 90_000n)).toBe(600);
    expect(reversalPoints(600, null, 1n)).toBe(600);
    expect(tierFor(tiers, 99)).toBeNull();
    expect(tierFor(tiers, 100)?.code).toBe('silver');
    expect(tierFor(tiers, 900)?.code).toBe('gold');
    expect(nextTier(tiers, 150)).toMatchObject({
      code: 'gold',
      pointsNeeded: 350,
    });
    expect(nextTier(tiers, 900)).toBeNull();
  });
});

const program = (over: object = {}) => ({
  id: 'prog',
  currencyCode: 'USD',
  spendPerPoint: 100n,
  pointValue: 1n,
  minRedeemPoints: 10,
  maxRedeemPercent: 50,
  expiryDays: 365,
  tierWindowDays: 365,
  isActive: true,
  tiers,
  ...over,
});

function setup(
  opts: {
    balance?: number;
    tierId?: string | null;
    windowPoints?: number;
    program?: object | null;
    account?: boolean;
  } = {},
) {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  prisma.customer.findUnique.mockResolvedValue({ websiteId: 'w' });
  prisma.loyaltyProgram.findUnique.mockResolvedValue(
    opts.program === null ? null : program(opts.program ?? {}),
  );
  prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('SUM(points)'))
      return [{ points: BigInt(opts.windowPoints ?? 0) }];
    if (sql.includes('FROM loyalty_accounts WHERE id'))
      return [{ customerId: 'cu' }];
    if (sql.includes('FOR UPDATE'))
      return opts.account === false
        ? []
        : [
            {
              id: 'acc',
              balance: opts.balance ?? 0,
              lifetimePoints: 0,
              tierId: opts.tierId ?? null,
            },
          ];
    return [];
  });
  prisma.loyaltyAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'acc',
    balance: 0,
  });
  prisma.loyaltyTransaction.create.mockImplementation(async ({ data }) => ({
    id: `tx-${data.type}`,
    ...data,
  }));
  return { svc: new LoyaltyService(prisma as never, fb.bus), prisma, ...fb };
}

describe('LoyaltyService', () => {
  it('opens accounts only where a program exists', async () => {
    const none = setup({ program: null });
    expect(await none.svc.openAccount('cu')).toBe(false);
    const s = setup();
    s.prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await s.svc.openAccount('cu')).toBe(true);
    expect(await s.svc.openAccount('cu')).toBe(false);
    expect(s.afterNames()).toEqual(['loyalty.account-opened']);
    s.prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(s.svc.openAccount('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('earns with the tier multiplier, once per order, and moves up a tier', async () => {
    const s = setup({ tierId: 't1', windowPoints: 600 });
    await s.svc.earn(
      'cu',
      { orderRef: 'O1', amount: 50_000, currencyCode: 'USD' },
      SYSTEM_ACTOR,
      NOW,
    );
    const earn = s.prisma.loyaltyTransaction.create.mock.calls[0][0].data;
    expect(earn).toMatchObject({
      type: 'EARN',
      points: 600,
      remaining: 600,
      amount: 50_000n,
    });
    expect(earn.expiresAt).toEqual(new Date(NOW.getTime() + 365 * DAY));
    expect(s.prisma.loyaltyAccount.update.mock.calls[0][0].data).toEqual({
      balance: 600,
      lifetimePoints: 600,
    });
    expect(s.prisma.loyaltyAccount.update.mock.calls[1][0].data).toEqual({
      tierId: 't2',
    });
    expect(s.afterNames()).toEqual([
      'loyalty.tier-changed',
      'loyalty.points-earned',
    ]);

    s.prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce({ id: 'old' });
    expect(
      (
        await s.svc.earn(
          'cu',
          { orderRef: 'O1', amount: 1, currencyCode: 'USD' },
          SYSTEM_ACTOR,
        )
      ).transactions,
    ).toEqual([]);
    expect(
      (
        await s.svc.earn(
          'cu',
          { orderRef: 'O2', amount: 50, currencyCode: 'USD' },
          SYSTEM_ACTOR,
        )
      ).transactions,
    ).toEqual([]);
    await expect(
      s.svc.earn(
        'cu',
        { orderRef: 'O3', amount: 50, currencyCode: 'EUR' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    const paused = setup({ program: { isActive: false } });
    await expect(
      paused.svc.earn(
        'cu',
        { orderRef: 'O', amount: 1, currencyCode: 'USD' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const noProgram = setup({ program: null });
    await expect(
      noProgram.svc.earn(
        'cu',
        { orderRef: 'O', amount: 1, currencyCode: 'USD' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow('no loyalty program');
    const noTiers = setup({ program: { tiers: [], expiryDays: null } });
    await noTiers.svc.earn(
      'cu',
      { orderRef: 'O', amount: 1000, currencyCode: 'USD' },
      SYSTEM_ACTOR,
    );
    expect(
      noTiers.prisma.loyaltyTransaction.create.mock.calls[0][0].data.expiresAt,
    ).toBeNull();
  });

  it('redeems within the rules, FIFO, once per order', async () => {
    const s = setup({ balance: 100 });
    s.prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce({
      points: -30,
    });
    expect(
      (await s.svc.redeem('cu', { orderRef: 'R0', points: 30 }, SYSTEM_ACTOR))
        .value,
    ).toBe('30');
    await expect(
      s.svc.redeem('cu', { orderRef: 'R1', points: 5 }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.svc.redeem(
        'cu',
        { orderRef: 'R1', points: 60, orderAmount: 100 },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow('at most 50%');
    await expect(
      s.svc.redeem('cu', { orderRef: 'R1', points: 500 }, SYSTEM_ACTOR),
    ).rejects.toThrow('Only 100 points');
    s.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { id: 'c1', remaining: 30 },
      { id: 'c2', remaining: 50 },
    ]);
    await expect(
      s.svc.redeem('cu', { orderRef: 'R1', points: 90 }, SYSTEM_ACTOR),
    ).rejects.toThrow('Only 80 points');
    s.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { id: 'c1', remaining: 30 },
      { id: 'c2', remaining: 50 },
    ]);
    const r = await s.svc.redeem(
      'cu',
      { orderRef: 'R1', points: 40, orderAmount: 1000 },
      ROOT_ACTOR,
    );
    expect(r.value).toBe('40');
    expect(
      s.prisma.loyaltyAllocation.create.mock.calls.map((c) => c[0].data),
    ).toEqual([
      { debitId: 'tx-REDEEM', creditId: 'c1', points: 30 },
      { debitId: 'tx-REDEEM', creditId: 'c2', points: 10 },
    ]);
    const paused = setup({ program: { isActive: false } });
    await expect(
      paused.svc.redeem('cu', { orderRef: 'X', points: 10 }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    const missing = setup({ account: false });
    await expect(
      missing.svc.redeem('cu', { orderRef: 'X', points: 10 }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reverses: returns redeemed points (except expired ones) and claws back earned ones', async () => {
    const s = setup({ balance: 50 });
    // REVERSE history, then the REDEEM with its allocations, then the EARN.
    s.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    s.prisma.loyaltyTransaction.findFirst
      .mockResolvedValueOnce({
        debits: [
          { points: 20, credit: { id: 'c1', expiresAt: null } },
          {
            points: 5,
            credit: { id: 'c0', expiresAt: new Date(NOW.getTime() - DAY) },
          },
        ],
      })
      .mockResolvedValueOnce({ id: 'e1', points: 200, amount: 20_000n });
    s.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { id: 'e1', remaining: 70 },
    ]);
    const r = await s.svc.reverse('cu', { orderRef: 'O1' }, SYSTEM_ACTOR, NOW);
    // 50 + 20 restored = 70 available; 200 wanted → 70 clawed back, the rest noted.
    expect(r.transactions.map((t) => [t.type, t.points])).toEqual([
      ['REVERSE', 20],
      ['REVERSE', -70],
    ]);
    const created = s.prisma.loyaltyTransaction.create.mock.calls.map(
      (c) => c[0].data,
    );
    expect(created[0].note).toContain('5 redeemed points had expired');
    expect(created[1].note).toBe('130 points were already spent');
    expect(s.afterNames()).toContain('loyalty.points-reversed');

    // Partial refund of an order that was partly reversed before; nothing more to restore.
    const p = setup({ balance: 500 });
    p.prisma.loyaltyTransaction.findMany
      .mockResolvedValueOnce([{ points: -100 }, { points: 10 }])
      .mockResolvedValueOnce([{ id: 'e1', remaining: 500 }]);
    p.prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce({
      id: 'e1',
      points: 300,
      amount: 30_000n,
    });
    const part = await p.svc.reverse(
      'cu',
      { orderRef: 'O1', amount: 15_000, restoreRedeemed: true },
      SYSTEM_ACTOR,
      NOW,
    );
    expect(part.transactions.map((t) => t.points)).toEqual([-150]);

    // Fully reversed already: nothing happens; unknown orders 404.
    const done = setup({ balance: 0 });
    done.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { points: -300 },
    ]);
    done.prisma.loyaltyTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'e1',
        points: 300,
        amount: 30_000n,
      });
    expect(
      (await done.svc.reverse('cu', { orderRef: 'O1' }, SYSTEM_ACTOR, NOW))
        .transactions,
    ).toEqual([]);
    const unknown = setup();
    unknown.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    unknown.prisma.loyaltyTransaction.findFirst.mockResolvedValue(null);
    await expect(
      unknown.svc.reverse('cu', { orderRef: 'X' }, SYSTEM_ACTOR, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    // An order that only redeemed (partial refund keeps the redemption): no-op, not 404.
    const onlyRedeemed = setup();
    onlyRedeemed.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    onlyRedeemed.prisma.loyaltyTransaction.findFirst.mockResolvedValue(null);
    onlyRedeemed.prisma.loyaltyTransaction.count.mockResolvedValueOnce(1);
    expect(
      (
        await onlyRedeemed.svc.reverse(
          'cu',
          { orderRef: 'R', amount: 5 },
          SYSTEM_ACTOR,
          NOW,
        )
      ).transactions,
    ).toEqual([]);
  });

  it('adjusts both ways', async () => {
    const s = setup({ balance: 10 });
    await s.svc.adjust(
      'cu',
      { points: 25, note: 'Goodwill' },
      SYSTEM_ACTOR,
      NOW,
    );
    expect(
      s.prisma.loyaltyTransaction.create.mock.calls[0][0].data,
    ).toMatchObject({ type: 'ADJUST', points: 25, remaining: 25 });
    await expect(
      s.svc.adjust('cu', { points: -500, note: 'x' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    s.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { id: 'c', remaining: 10 },
    ]);
    await s.svc.adjust('cu', { points: -5, note: 'Correction' }, SYSTEM_ACTOR);
    expect(s.afterNames()).toEqual([
      'loyalty.points-adjusted',
      'loyalty.points-adjusted',
    ]);
    const never = setup({ program: { expiryDays: null } });
    await never.svc.adjust('cu', { points: 1, note: 'x y' }, SYSTEM_ACTOR);
    expect(
      never.prisma.loyaltyTransaction.create.mock.calls[0][0].data.expiresAt,
    ).toBeNull();
  });

  it('expires due credits per account, in batches', async () => {
    const s = setup({ balance: 40 });
    s.prisma.loyaltyTransaction.findMany
      .mockResolvedValueOnce([{ accountId: 'acc' }]) // due accounts (batch of 1 → next round)
      .mockResolvedValueOnce([
        { id: 'c1', remaining: 30 },
        { id: 'c2', remaining: 10 },
      ])
      .mockResolvedValueOnce([]); // next round: none
    expect(await s.svc.expireDue(NOW, 1)).toBe(40);
    expect(s.prisma.loyaltyAllocation.create).toHaveBeenCalledTimes(2);
    expect(s.afterNames()).toEqual(['loyalty.points-expired']);
    const gone = setup();
    gone.prisma.$queryRaw.mockResolvedValueOnce([]);
    gone.prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([
      { accountId: 'acc' },
    ]);
    expect(await gone.svc.expireDue(NOW)).toBe(0);
    const nothing = setup();
    nothing.prisma.loyaltyTransaction.findMany
      .mockResolvedValueOnce([{ accountId: 'acc' }])
      .mockResolvedValueOnce([]);
    expect(await nothing.svc.expireDue(NOW)).toBe(0);
  });

  it('re-evaluates tiers nightly, paging through accounts', async () => {
    const s = setup({ tierId: 't2', windowPoints: 120 });
    s.prisma.loyaltyAccount.findMany
      .mockResolvedValueOnce([{ id: 'a1', customerId: 'cu' }])
      .mockResolvedValueOnce([]);
    expect(await s.svc.evaluateTiers(NOW, 1)).toBe(1);
    expect(s.prisma.loyaltyAccount.update.mock.calls[0][0].data).toEqual({
      tierId: 't1',
    });
    const same = setup({ tierId: 't1', windowPoints: 120 });
    same.prisma.loyaltyAccount.findMany.mockResolvedValueOnce([
      { id: 'a1', customerId: 'cu' },
    ]);
    expect(await same.svc.evaluateTiers(NOW)).toBe(0);
  });
});

const ROOT_ACTOR = { type: 'admin' as const, id: ROOT.id, label: ROOT.label };

describe('LoyaltyProgramsService', () => {
  const row = (over: object = {}) => ({
    id: 'prog',
    websiteId: 'w',
    name: 'Rewards',
    currencyCode: 'USD',
    spendPerPoint: 100n,
    pointValue: 1n,
    minRedeemPoints: 0,
    maxRedeemPercent: 100,
    expiryDays: null,
    tierWindowDays: 365,
    isActive: true,
    tiers: [],
    ...over,
  });

  it('upserts programs and manages tiers', async () => {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const svc = new LoyaltyProgramsService(prisma as never, fb.bus);
    prisma.loyaltyProgram.findMany.mockResolvedValue([row()]);
    expect((await svc.list())[0].spendPerPoint).toBe('100');
    prisma.loyaltyProgram.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('w')).rejects.toBeInstanceOf(NotFoundException);
    const dto = {
      name: 'Rewards',
      currencyCode: 'USD',
      spendPerPoint: 100,
      pointValue: 1,
    };
    prisma.loyaltyProgram.findUnique.mockResolvedValueOnce(null);
    prisma.loyaltyProgram.upsert.mockResolvedValue(row());
    await svc.upsert('w', dto, ROOT);
    prisma.loyaltyProgram.findUnique.mockResolvedValueOnce(
      row({ name: 'Old' }),
    );
    await svc.upsert(
      'w',
      {
        ...dto,
        expiryDays: 30,
        minRedeemPoints: 5,
        maxRedeemPercent: 50,
        tierWindowDays: 90,
        isActive: false,
      },
      ROOT,
    );
    prisma.loyaltyProgram.findUnique.mockResolvedValueOnce(row());
    await svc.upsert('w', dto, ROOT);
    expect(fb.afterNames()).toEqual([
      'loyalty-program.created',
      'loyalty-program.updated',
    ]);

    prisma.loyaltyProgram.findUnique.mockResolvedValue(row());
    prisma.loyaltyTier.create.mockResolvedValue(tiers[0]);
    await svc.addTier(
      'w',
      { code: 'gold', name: 'Gold', thresholdPoints: 500 },
      ROOT,
    );
    prisma.loyaltyTier.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateTier('t', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.loyaltyTier.findUnique.mockResolvedValue(tiers[0]);
    prisma.loyaltyTier.update
      .mockResolvedValueOnce({ ...tiers[0], name: 'Platinum' })
      .mockResolvedValueOnce(tiers[0]);
    await svc.updateTier('t', { name: 'Platinum' }, ROOT);
    await svc.updateTier('t', {}, ROOT);
    prisma.loyaltyTier.findUnique.mockResolvedValueOnce(null);
    await expect(svc.removeTier('t', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.removeTier('t', ROOT);
    expect(fb.afterNames().slice(2)).toEqual([
      'loyalty-tier.created',
      'loyalty-tier.updated',
      'loyalty-tier.deleted',
    ]);
  });
});

describe('LoyaltyQuery', () => {
  const stores = {
    snapshot: vi.fn(async () => ({
      currencies: new Map([['USD', { minorUnits: 2 }]]),
    })),
  };

  it('summarises points, worth, tier progress and expiring points for the shopper', async () => {
    const prisma = fakePrisma();
    const q = new LoyaltyQuery(prisma as never, stores as never);
    expect(
      await q.summary({ id: 'cu' } as never, 'en-US', NOW),
    ).toBeUndefined();
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce({
      id: 'acc',
      balance: 1250,
      tierId: 't1',
      program: {
        name: 'Rewards',
        currencyCode: 'USD',
        spendPerPoint: 100n,
        pointValue: 1n,
        minRedeemPoints: 100,
        tierWindowDays: 365,
        tiers,
      },
    });
    prisma.loyaltyTransaction.aggregate.mockResolvedValueOnce({
      _sum: { points: 300 },
    });
    prisma.loyaltyTransaction.findMany
      .mockResolvedValueOnce([
        { remaining: 40, expiresAt: new Date(NOW.getTime() + 10 * DAY) },
        { remaining: 60, expiresAt: new Date(NOW.getTime() + 90 * DAY) },
      ])
      .mockResolvedValueOnce([]);
    expect(await q.summary({ id: 'cu' } as never, 'en-US', NOW)).toMatchObject({
      balance: 1250,
      balanceValue: '$12.50',
      pointsPerUnit: 1,
      tier: { code: 'silver', multiplier: 1.2 },
      nextTier: { code: 'gold', pointsNeeded: 200 },
      expiringSoon: 40,
    });
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce({
      id: 'acc',
      balance: 0,
      tierId: null,
      program: {
        name: 'R',
        currencyCode: 'XXX',
        spendPerPoint: 100n,
        pointValue: 1n,
        minRedeemPoints: 0,
        tierWindowDays: 1,
        tiers: [],
      },
    });
    prisma.loyaltyTransaction.aggregate.mockResolvedValueOnce({
      _sum: { points: null },
    });
    expect(await q.summary({ id: 'cu' } as never, 'en-US', NOW)).toMatchObject({
      tier: null,
      nextTier: null,
      nextExpiryAt: null,
    });
  });

  it('lists accounts and transactions; 404 without an account', async () => {
    const prisma = fakePrisma();
    const q = new LoyaltyQuery(prisma as never, stores as never);
    await q.accounts({
      page: 1,
      limit: 10,
      order: 'desc',
      skip: 0,
      websiteId: 'w',
      tierCode: 'gold',
    } as never);
    await q.accounts({ page: 1, limit: 10, order: 'desc', skip: 0 } as never);
    await q.transactions('cu', {
      page: 1,
      limit: 10,
      order: 'desc',
      skip: 0,
      type: 'EARN',
    } as never);
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce(null);
    await expect(q.accountOf('cu')).rejects.toBeInstanceOf(NotFoundException);
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce({ id: 'acc' });
    prisma.loyaltyAccount.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'acc',
    });
    expect(await q.accountOf('cu')).toEqual({ id: 'acc' });
  });

  it('tells checkout what a customer may redeem', async () => {
    const prisma = fakePrisma();
    const q = new LoyaltyQuery(prisma as never, stores as never);
    expect(await q.redemptionTerms('cu')).toBeUndefined();
    const program = {
      isActive: true,
      pointValue: 1n,
      currencyCode: 'USD',
      minRedeemPoints: 100,
      maxRedeemPercent: 50,
    };
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce({
      balance: 300,
      program,
    });
    expect(await q.redemptionTerms('cu')).toEqual({
      balance: 300,
      pointValue: 1n,
      currencyCode: 'USD',
      minRedeemPoints: 100,
      maxRedeemPercent: 50,
    });
    prisma.loyaltyAccount.findUnique.mockResolvedValueOnce({
      balance: 300,
      program: { ...program, isActive: false },
    });
    expect(await q.redemptionTerms('cu')).toBeUndefined();
  });
});

describe('loyalty wiring', () => {
  it('controllers, listener, jobs', async () => {
    expect(
      (
        await exerciseController(
          new LoyaltyAdminController(
            stubService() as never,
            stubService() as never,
            stubService() as never,
          ),
        )
      ).failed,
    ).toBe(0);
    expect(
      (
        await exerciseController(
          new AccountLoyaltyController(stubService() as never),
        )
      ).failed,
    ).toBe(0);
    expect(
      (
        await exerciseController(
          new AccountLoyaltyController(stubService(undefined) as never),
        )
      ).failed,
    ).toBe(1);
    const loyalty = {
      openAccount: vi.fn(),
      expireDue: vi.fn(async () => 3),
      evaluateTiers: vi.fn(async () => 2),
    };
    const l = new LoyaltyListener(loyalty as never);
    await l.onRegistered({ data: { customerId: 'a' } } as never);
    await l.onCreated({ data: { customerId: 'b' } } as never);
    expect(loyalty.openAccount.mock.calls).toEqual([['a'], ['b']]);
    const p = new LoyaltyProcessor(loyalty as never);
    expect(
      await p.process({ name: 'loyalty-expire-points', data: {} } as never),
    ).toEqual({ expired: 3 });
    expect(
      await p.process({ name: 'loyalty-evaluate-tiers', data: {} } as never),
    ).toEqual({ changed: 2 });
    expect(await p.process({ name: 'x', data: {} } as never)).toEqual({
      skipped: 'unknown job x',
    });
    const queue = { upsertJobScheduler: vi.fn() };
    await new LoyaltyScheduler(queue as never).onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
  });
});
