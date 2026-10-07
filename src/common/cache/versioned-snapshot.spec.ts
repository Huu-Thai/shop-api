import { VersionedSnapshot } from './versioned-snapshot.js';

describe('VersionedSnapshot', () => {
  function setup() {
    let version: string | null = '1';
    let loads = 0;
    const redis = {
      get: vi.fn(async () => version),
      incr: vi.fn(async () => 2),
    };
    const snap = new VersionedSnapshot(
      redis as never,
      'k',
      async () => ++loads,
      5_000,
      60_000,
    );
    return {
      snap,
      redis,
      bump: (v: string | null) => (version = v),
      loads: () => loads,
    };
  }

  it('caches, checks the version at most every checkMs, reloads on change', async () => {
    const { snap, redis, bump, loads } = setup();
    expect(await Promise.all([snap.get(), snap.get()])).toEqual([1, 1]);
    expect(loads()).toBe(1);
    vi.useFakeTimers({ now: Date.now() + 6_000 });
    expect(await snap.get()).toBe(1); // same version → keep
    bump('2');
    vi.setSystemTime(Date.now() + 6_000);
    expect(await snap.get()).toBe(2);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await snap.get()).toBe(3); // max age
    vi.useRealTimers();
    expect(redis.get).toHaveBeenCalled();
  });

  it('fresh reads bypass the cache; invalidate drops it and bumps the counter', async () => {
    const { snap, redis, loads } = setup();
    await snap.get();
    expect(await snap.get(true)).toBe(2);
    await snap.invalidate();
    expect(redis.incr).toHaveBeenCalledWith('k');
    expect(await snap.get()).toBe(3);
    expect(loads()).toBe(3);
  });

  it('survives Redis errors', async () => {
    const redis = {
      get: vi.fn(async () => Promise.reject(new Error('down'))),
      incr: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    const snap = new VersionedSnapshot(redis as never, 'k', async () => 'v');
    expect(await snap.get()).toBe('v');
    expect(await snap.get(true)).toBe('v');
    await expect(snap.invalidate()).resolves.toBeUndefined();
  });
});
