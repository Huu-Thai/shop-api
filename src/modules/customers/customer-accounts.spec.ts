import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sha256 } from '../../common/auth/api-key-format.js';
import { hashPassword } from '../../common/auth/password.js';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import {
  CustomerRequiredGuard,
  StoreContextGuard,
} from '../stores/context/store-context.guard.js';
import type { StoreContext } from '../stores/context/store-context.js';
import {
  AccountAuthController,
  AccountController,
} from './account.controller.js';
import { AddressesService, MAX_ADDRESSES } from './addresses.service.js';
import { CustomerAuthService } from './auth/customer-auth.service.js';
import { CustomerSessionService } from './auth/customer-session.service.js';
import { CustomerTokenResolverService } from './auth/customer-token.resolver.js';
import { CustomersAdminController } from './customers.admin.controller.js';
import { CustomersQuery } from './customers.query.js';
import { CustomersService } from './customers.service.js';

const PASSWORD = 'Correct-Horse-42!';
const SECRET = 's'.repeat(32);
const AUTH = {
  jwtSecret: SECRET,
  issuer: 'shop',
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
  maxFailedLogins: 3,
  lockoutMinutes: 15,
};
const config = { get: () => AUTH };
const ctx = {
  storeId: 's1',
  storeCode: 'us-en',
  websiteId: 'w1',
  localeCode: 'en-US',
} as StoreContext;
const customer = {
  id: 'c1',
  websiteId: 'w1',
  email: 'ann@example.com',
  groupId: 'g',
  groupCode: 'general',
  sessionId: 'fam',
};

function redis() {
  const keys = new Set<string>();
  return {
    keys,
    set: vi.fn(async (k: string) => keys.add(k)),
    exists: vi.fn(async (k: string) => (keys.has(k) ? 1 : 0)),
  };
}

describe('CustomerSessionService', () => {
  it('issues JWT + rotating refresh token, revokes families', async () => {
    const r = redis();
    const s = new CustomerSessionService(
      new JwtService({}),
      config as never,
      r as never,
    );
    const tx = fakePrisma();
    tx.customerSession.create.mockResolvedValue({ id: 'row' });
    const issued = await s.issue(
      tx as never,
      { id: 'c1', websiteId: 'w1' },
      { ip: '1.2.3.4', userAgent: 'UA' },
    );
    expect(issued.pair.refreshToken).toHaveLength(43);
    expect(tx.customerSession.create.mock.calls[0][0].data).toMatchObject({
      customerId: 'c1',
      tokenHash: sha256(issued.pair.refreshToken),
      ip: '1.2.3.4',
    });
    const claims = new JwtService({}).decode(issued.pair.accessToken);
    expect(claims).toMatchObject({ sub: 'c1', ws: 'w1', aud: 'shop-customer' });
    await s.issue(tx as never, { id: 'c1', websiteId: 'w1' }, {});
    tx.customerSession.findMany.mockResolvedValue([{ familyId: 'f1' }]);
    expect(await s.revokeFamilies(tx as never, { customerId: 'c1' })).toEqual([
      'f1',
    ]);
    await s.markRevoked(['f1', 'f1']);
    expect(r.set).toHaveBeenCalledTimes(1);
  });
});

describe('CustomerTokenResolverService', () => {
  async function setup() {
    const r = redis();
    const jwt = new JwtService({});
    const prisma = fakePrisma();
    const resolver = new CustomerTokenResolverService(
      prisma as never,
      jwt,
      config as never,
      r as never,
    );
    const sign = (claims: object, aud = 'shop-customer') =>
      jwt.signAsync(
        { sub: 'c1', sid: 'fam', ws: 'w1', ...claims },
        { secret: SECRET, issuer: 'shop', audience: aud, expiresIn: 60 },
      );
    prisma.customer.findUnique.mockResolvedValue({
      id: 'c1',
      websiteId: 'w1',
      email: 'ann@example.com',
      status: 'ACTIVE',
      passwordChangedAt: new Date(Date.now() - 60_000),
      customerGroup: { id: 'g', code: 'general' },
    });
    return { resolver, sign, prisma, r };
  }

  it('accepts valid customer tokens only', async () => {
    const { resolver, sign, prisma, r } = await setup();
    expect(await resolver.resolve(await sign({}))).toEqual(customer);
    await expect(
      resolver.resolve(await sign({}, 'shop-admin')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(resolver.resolve('garbage')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(resolver.resolve(await sign({ ws: 'w2' }))).rejects.toThrow(
      'Session has ended',
    );
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 'c1',
      websiteId: 'w1',
      status: 'DISABLED',
      passwordChangedAt: new Date(0),
      customerGroup: { id: 'g', code: 'general' },
    });
    await expect(resolver.resolve(await sign({}))).rejects.toThrow(
      'Session has ended',
    );
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 'c1',
      websiteId: 'w1',
      status: 'ACTIVE',
      passwordChangedAt: new Date(Date.now() + 120_000),
      customerGroup: { id: 'g', code: 'general' },
    });
    await expect(resolver.resolve(await sign({}))).rejects.toThrow(
      'Session has ended',
    );
    r.keys.add('auth:customer-revoked-session:fam');
    await expect(resolver.resolve(await sign({}))).rejects.toThrow(
      'Session has ended',
    );
  });
});

describe('CustomerAuthService', () => {
  async function setup(over: Record<string, unknown> = {}) {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const row = {
      id: 'c1',
      email: 'ann@example.com',
      websiteId: 'w1',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      lockedUntil: null as Date | null,
      ...over,
    };
    prisma.customer.findUnique.mockResolvedValue(row);
    prisma.customer.findUniqueOrThrow.mockResolvedValue(row);
    prisma.customer.create.mockResolvedValue(row);
    const pair = {
      tokenType: 'Bearer',
      accessToken: 'a',
      expiresIn: 900,
      refreshToken: 'r',
      refreshTokenExpiresAt: new Date(),
    };
    const sessions = {
      issue: vi.fn(
        async (
          _t: unknown,
          _c: unknown,
          _m: unknown,
          familyId = 'fam-new',
        ) => ({ pair, sessionRowId: 'row-new', familyId }),
      ),
      revokeFamilies: vi.fn(async (..._a: unknown[]) => ['fam-1']),
      markRevoked: vi.fn(async () => undefined),
    };
    const groups = {
      groupByCode: vi.fn(async () => ({
        id: 'g',
        code: 'general',
        taxClassId: null,
      })),
    };
    const svc = new CustomerAuthService(
      prisma as never,
      fb.bus,
      sessions as never,
      groups as never,
      config as never,
    );
    return { svc, prisma, sessions, ...fb };
  }

  it('registers with the password policy and the default group', async () => {
    const { svc, prisma, afterNames } = await setup();
    await expect(
      svc.register(
        ctx,
        {
          email: 'ann@example.com',
          password: 'short',
          firstName: 'A',
          lastName: 'B',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.register(
      ctx,
      {
        email: 'ann@example.com',
        password: PASSWORD,
        firstName: 'A',
        lastName: 'B',
        acceptsMarketing: true,
      },
      {},
    );
    expect(prisma.customer.create.mock.calls[0][0].data).toMatchObject({
      websiteId: 'w1',
      customerGroupId: 'g',
      localeCode: 'en-US',
      acceptsMarketing: true,
    });
    expect(afterNames()).toEqual(['customer.registered']);
  });

  it('logs in per website with one generic error and lockout', async () => {
    const { svc, prisma, afterNames } = await setup();
    expect(
      (await svc.login(ctx, 'ann@example.com', PASSWORD, {})).accessToken,
    ).toBe('a');
    prisma.customer.update.mockResolvedValue({ failedLogins: 3 });
    await expect(
      svc.login(ctx, 'ann@example.com', 'wrong', {}),
    ).rejects.toThrow('Invalid e-mail or password');
    expect(afterNames()).toEqual([
      'customer.logged-in',
      'customer.login-failed',
      'customer.locked',
    ]);
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.login(ctx, 'x@example.com', PASSWORD, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const locked = await setup({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(
      locked.svc.login(ctx, 'ann@example.com', PASSWORD, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const disabled = await setup({ status: 'DISABLED' });
    await expect(
      disabled.svc.login(ctx, 'ann@example.com', PASSWORD, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotates refresh tokens and revokes a family on reuse', async () => {
    const { svc, prisma, sessions, afterNames } = await setup();
    const token = (extra: object = {}) => ({
      id: 't',
      familyId: 'fam',
      revokedAt: null,
      replacedById: null,
      expiresAt: new Date(Date.now() + 60_000),
      customer: {
        id: 'c1',
        email: 'ann@example.com',
        websiteId: 'w1',
        status: 'ACTIVE',
      },
      ...extra,
    });
    prisma.customerSession.findUnique.mockResolvedValueOnce(null);
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    prisma.customerSession.findUnique.mockResolvedValueOnce(
      token({ customer: { id: 'c1', websiteId: 'other' } }),
    );
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toThrow(
      'Invalid refresh token',
    );
    prisma.customerSession.findUnique.mockResolvedValueOnce(
      token({ replacedById: 'next' }),
    );
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toThrow(
      'no longer valid',
    );
    expect(sessions.markRevoked).toHaveBeenCalledWith(['fam-1']);
    prisma.customerSession.findUnique.mockResolvedValueOnce(
      token({ revokedAt: new Date() }),
    );
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toThrow(
      'no longer valid',
    );
    prisma.customerSession.findUnique.mockResolvedValueOnce(
      token({ expiresAt: new Date(0) }),
    );
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toThrow(
      'Session expired',
    );
    prisma.customerSession.findUnique.mockResolvedValueOnce(token());
    prisma.customerSession.updateMany.mockResolvedValueOnce({ count: 1 });
    expect((await svc.refresh(ctx, 'raw', {})).accessToken).toBe('a');
    prisma.customerSession.findUnique.mockResolvedValueOnce(token());
    prisma.customerSession.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.refresh(ctx, 'raw', {})).rejects.toThrow(
      'no longer valid',
    );
    expect(afterNames()).toEqual(['customer.token-reuse-detected']);
  });

  it('logs out and changes passwords (ending sessions)', async () => {
    const { svc, sessions, afterNames } = await setup();
    await svc.logout(customer, false);
    await svc.logout(customer, true);
    expect(sessions.revokeFamilies.mock.calls.map((c) => c[1])).toEqual([
      { familyId: 'fam' },
      { customerId: 'c1' },
    ]);
    await expect(
      svc.changePassword(customer, 'wrong', 'Another-Pass-77!'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      svc.changePassword(customer, PASSWORD, 'short'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.changePassword(customer, PASSWORD, PASSWORD),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.changePassword(customer, PASSWORD, 'Another-Pass-77!');
    expect(afterNames()).toEqual([
      'customer.logged-out',
      'customer.logged-out',
      'customer.password-changed',
    ]);
  });
});

const row = (over: object = {}) => ({
  id: 'c1',
  websiteId: 'w1',
  email: 'ann@example.com',
  firstName: 'Ann',
  lastName: 'Lee',
  phone: null,
  localeCode: 'en-US',
  status: 'ACTIVE',
  acceptsMarketing: false,
  lastLoginAt: null,
  lockedUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customerGroupId: 'g',
  customerGroup: { code: 'general' },
  ...over,
});

describe('CustomersService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const groups = {
      groupByCode: vi.fn(async (code: string) => ({
        id: `g-${code}`,
        code,
        taxClassId: null,
      })),
    };
    const sessions = {
      revokeFamilies: vi.fn(async () => ['f']),
      markRevoked: vi.fn(),
    };
    return {
      svc: new CustomersService(
        prisma as never,
        fb.bus,
        groups as never,
        sessions as never,
      ),
      prisma,
      sessions,
      ...fb,
    };
  }

  it('admin CRUD: create, regroup, disable (ending sessions), delete', async () => {
    const { svc, prisma, sessions, afterNames } = setup();
    await expect(
      svc.create(
        {
          websiteId: 'w1',
          email: 'a@b.co',
          password: 'x',
          firstName: 'A',
          lastName: 'B',
        },
        ROOT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.customer.create.mockResolvedValue(row());
    expect(
      (
        await svc.create(
          {
            websiteId: 'w1',
            email: 'ann@example.com',
            password: PASSWORD,
            firstName: 'A',
            lastName: 'B',
            groupCode: 'vip',
          },
          ROOT,
        )
      ).groupCode,
    ).toBe('general');
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('c1', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.customer.findUnique.mockResolvedValue(row());
    prisma.customer.update
      .mockResolvedValueOnce(
        row({
          status: 'DISABLED',
          customerGroupId: 'g-wholesale',
          customerGroup: { code: 'wholesale' },
        }),
      )
      .mockResolvedValueOnce(row());
    await svc.update(
      'c1',
      { status: 'DISABLED', groupCode: 'wholesale' },
      ROOT,
    );
    expect(sessions.markRevoked).toHaveBeenCalledWith(['f']);
    await svc.update('c1', { status: 'ACTIVE' }, ROOT);
    expect(prisma.customer.update.mock.calls[1][0].data).toMatchObject({
      failedLogins: 0,
      lockedUntil: null,
    });
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('c1', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.remove('c1', ROOT);
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(svc.logoutEverywhere('c1', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.logoutEverywhere('c1', ROOT);
    expect(afterNames()).toEqual([
      'customer.created',
      'customer.updated',
      'customer.deleted',
      'customer.logged-out',
    ]);
  });

  it('lists and shows customers; the shopper edits their own profile', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.customer.findMany.mockResolvedValue([row()]);
    expect(
      (
        await svc.list({
          page: 1,
          limit: 10,
          order: 'desc',
          skip: 0,
          search: 'ann',
          groupCode: 'general',
          websiteId: 'w1',
        } as never)
      ).data[0].groupCode,
    ).toBe('general');
    await svc.list({ page: 1, limit: 10, order: 'desc', skip: 0 } as never);
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('c1')).rejects.toBeInstanceOf(NotFoundException);
    prisma.customer.findUnique.mockResolvedValueOnce({
      ...row(),
      addresses: [],
    });
    expect((await svc.get('c1')).addresses).toEqual([]);
    prisma.customer.findUniqueOrThrow.mockResolvedValue(row());
    expect((await svc.profile(customer)).group).toBe('general');
    prisma.customer.update
      .mockResolvedValueOnce(row({ firstName: 'Annie' }))
      .mockResolvedValueOnce(row());
    expect(
      (await svc.updateProfile(customer, { firstName: 'Annie' })).firstName,
    ).toBe('Annie');
    await svc.updateProfile(customer, {});
    expect(afterNames()).toEqual(['customer.updated']);
  });
});

describe('AddressesService', () => {
  const dto = {
    firstName: 'A',
    lastName: 'B',
    countryCode: 'US',
    city: 'LA',
    line1: '1 Main',
    company: '',
    phone: '+1 555',
  };

  it('keeps one default of each kind and only the owner’s addresses', async () => {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const svc = new AddressesService(prisma as never, fb.bus);
    await svc.list('c1');
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(svc.create('c1', dto, ROOT as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.customerAddress.count.mockResolvedValueOnce(MAX_ADDRESSES);
    await expect(svc.create('c1', dto, ROOT as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.customerAddress.count.mockResolvedValueOnce(0);
    prisma.customerAddress.create.mockResolvedValue({
      id: 'a1',
      countryCode: 'US',
    });
    await svc.create('c1', dto, ROOT as never);
    expect(prisma.customerAddress.create.mock.calls[0][0].data).toMatchObject({
      isDefaultShipping: true,
      isDefaultBilling: true,
      company: null,
    });
    expect(prisma.customerAddress.updateMany).toHaveBeenCalledTimes(2);
    prisma.customerAddress.count.mockResolvedValueOnce(2);
    await svc.create('c1', { ...dto, isDefaultBilling: true }, ROOT as never);
    expect(prisma.customerAddress.create.mock.calls[1][0].data).toMatchObject({
      isDefaultShipping: false,
      isDefaultBilling: true,
    });
    prisma.customerAddress.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.update('c1', 'a1', {}, ROOT as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.customerAddress.findFirst.mockResolvedValue({ id: 'a1' });
    await svc.update(
      'c1',
      'a1',
      { isDefaultShipping: true, city: 'SF' },
      ROOT as never,
    );
    expect(
      prisma.customerAddress.updateMany.mock.calls.at(-1)![0].where.id,
    ).toEqual({ not: 'a1' });
    await svc.remove('c1', 'a1', ROOT as never);
    expect(fb.afterNames()).toEqual([
      'customer-address.created',
      'customer-address.created',
      'customer-address.updated',
      'customer-address.deleted',
    ]);
  });
});

describe('CustomersQuery', () => {
  it('finds a customer’s group', async () => {
    const prisma = fakePrisma();
    const q = new CustomersQuery(prisma as never);
    prisma.customer.findUnique
      .mockResolvedValueOnce({ customerGroup: { code: 'vip' } })
      .mockResolvedValueOnce(null);
    expect(await q.groupOfCustomer('c')).toBe('vip');
    expect(await q.groupOfCustomer('x')).toBeUndefined();
  });
});

describe('storefront customer scope', () => {
  const snap = {
    byCode: new Map([
      [
        'us-en',
        {
          id: 's1',
          code: 'us-en',
          websiteId: 'w1',
          websiteCode: 'us',
          isActive: true,
          localeCodes: ['en-US'],
          defaultLocaleCode: 'en-US',
          currencyCodes: ['USD'],
          defaultCurrencyCode: 'USD',
          countryCode: 'US',
          pricesIncludeTax: false,
        },
      ],
    ]),
    byHost: new Map(),
    locales: new Map([['en-US', { isActive: true }]]),
    currencies: new Map(),
    fallbacks: new Map([['en-US', null]]),
  };
  const http = (authorization?: string) => {
    const req: Record<string, unknown> = {
      headers: {
        'x-store': 'us-en',
        ...(authorization ? { authorization } : {}),
      },
      query: {},
    };
    return {
      req,
      ctx: {
        getHandler: () => null,
        getClass: () => null,
        switchToHttp: () => ({ getRequest: () => req }),
      } as never,
    };
  };

  it('resolves an optional customer token for the store’s website', async () => {
    const stores = { snapshot: vi.fn(async () => snap) };
    const reflector = { getAllAndOverride: vi.fn(() => false) };
    const resolver = { resolve: vi.fn(async () => customer) };
    const guard = new StoreContextGuard(
      stores as never,
      reflector as never,
      resolver,
    );
    const anon = http();
    await guard.canActivate(anon.ctx);
    expect((anon.req.storeContext as StoreContext).customer).toBeUndefined();
    const signed = http('Bearer tok');
    await guard.canActivate(signed.ctx);
    expect((signed.req.storeContext as StoreContext).customer).toEqual(
      customer,
    );
    resolver.resolve.mockResolvedValueOnce({ ...customer, websiteId: 'w2' });
    await expect(
      guard.canActivate(http('Bearer tok').ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    reflector.getAllAndOverride.mockReturnValueOnce(true);
    const ignored = http('Bearer expired');
    await guard.canActivate(ignored.ctx);
    expect((ignored.req.storeContext as StoreContext).customer).toBeUndefined();
    // Without the customers module, tokens are simply not resolved.
    const plain = new StoreContextGuard(stores as never, reflector as never);
    await plain.canActivate(http('Bearer tok').ctx);

    const required = new CustomerRequiredGuard();
    expect(required.canActivate(signed.ctx)).toBe(true);
    expect(() => required.canActivate(anon.ctx)).toThrow(UnauthorizedException);
  });
});

describe('customer controllers', () => {
  it('delegate to their services', async () => {
    const req = { ip: '1.1.1.1', get: () => 'UA' };
    const auth = stubService();
    const c = new AccountAuthController(auth as never);
    await c.register(ctx, {} as never, req as never);
    await c.login(ctx, { email: 'a', password: 'b' } as never, req as never);
    await c.refresh(ctx, { refreshToken: 'r' } as never, req as never);
    expect(auth.login).toHaveBeenCalledWith(ctx, 'a', 'b', {
      ip: '1.1.1.1',
      userAgent: 'UA',
    });
    const account = new AccountController(
      stubService() as never,
      stubService() as never,
      stubService() as never,
    );
    expect((await exerciseController(account)).failed).toBe(0);
    await account.logout(customer, {});
    expect(
      (
        await exerciseController(
          new CustomersAdminController(
            stubService() as never,
            stubService() as never,
          ),
        )
      ).failed,
    ).toBe(0);
  });
});
