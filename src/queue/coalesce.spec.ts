import { isSuperseded, nextGeneration } from './coalesce.js';

describe('coalesced jobs', () => {
  it('only the latest request runs; jobs without a generation always run', async () => {
    let n = 0;
    const redis = {
      incr: vi.fn(async () => ++n),
      get: vi.fn(async () => (n ? String(n) : null)),
    } as never;
    expect(await isSuperseded(redis, 'k', undefined)).toBe(false);
    const first = await nextGeneration(redis, 'k');
    expect(await isSuperseded(redis, 'k', first)).toBe(false);
    const second = await nextGeneration(redis, 'k');
    expect(await isSuperseded(redis, 'k', first)).toBe(true);
    expect(await isSuperseded(redis, 'k', second)).toBe(false);
  });
});
