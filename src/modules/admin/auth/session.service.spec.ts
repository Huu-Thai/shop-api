import { JwtService } from '@nestjs/jwt';
import { sha256 } from '../../../common/auth/api-key-format.js';
import {
  ACCESS_AUDIENCE,
  revokedSessionKey,
} from '../../../common/auth/principal.resolver.js';
import { SessionService } from './session.service.js';

const settings = {
  jwtSecret: 'unit-test-jwt-secret-0123456789-abcdef',
  issuer: 'shop',
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
};

function setup() {
  const jwt = new JwtService({});
  const redis = { set: vi.fn(async () => 'OK') };
  const svc = new SessionService(
    jwt,
    { get: () => settings } as never,
    redis as never,
  );
  const tx = {
    refreshToken: {
      create: vi.fn(async () => ({ id: 'rt-1' })),
      findMany: vi.fn(async () => [{ familyId: 'f1' }, { familyId: 'f2' }]),
      updateMany: vi.fn(async () => ({ count: 3 })),
    },
  };
  return { svc, jwt, redis, tx };
}

describe('SessionService', () => {
  it('issues an access JWT bound to the session family and stores only the refresh-token hash', async () => {
    const { svc, jwt, tx } = setup();
    const { pair, refreshTokenId, familyId } = await svc.issue(
      tx as never,
      'u1',
      { ip: '10.0.0.1', userAgent: 'x'.repeat(400) },
    );
    expect(refreshTokenId).toBe('rt-1');
    const data = (
      tx.refreshToken.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      adminUserId: 'u1',
      familyId,
      tokenHash: sha256(pair.refreshToken),
      ip: '10.0.0.1',
    });
    expect((data.userAgent as string).length).toBe(255);
    expect(JSON.stringify(data)).not.toContain(pair.refreshToken);
    const claims = await jwt.verifyAsync(pair.accessToken, {
      secret: settings.jwtSecret,
      audience: ACCESS_AUDIENCE,
      issuer: 'shop',
    });
    expect(claims).toMatchObject({ sub: 'u1', sid: familyId });
    expect(pair).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
  });

  it('keeps the family on rotation', async () => {
    const { svc, tx } = setup();
    expect((await svc.issue(tx as never, 'u1', {}, 'fam-x')).familyId).toBe(
      'fam-x',
    );
  });

  it('revokes active tokens and reports the affected families', async () => {
    const { svc, tx } = setup();
    expect(
      await svc.revokeFamilies(tx as never, { adminUserId: 'u1' }),
    ).toEqual(['f1', 'f2']);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { adminUserId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('marks sessions revoked in Redis for the access-token lifetime, tolerating Redis errors', async () => {
    const { svc, redis } = setup();
    redis.set.mockRejectedValueOnce(new Error('down') as never);
    await expect(svc.markRevoked(['f1', 'f2'])).resolves.toBeUndefined();
    expect(redis.set).toHaveBeenCalledWith(
      revokedSessionKey('f2'),
      '1',
      'EX',
      960,
    );
  });
});
