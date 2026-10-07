import type {
  HealthCheckService,
  HealthIndicatorFunction,
} from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import type { HealthIndicators } from './health.indicators.js';

function setup() {
  const indicators = {
    database: vi.fn(async () => ({ database: { status: 'up' } })),
    redisPing: vi.fn(async () => ({ redis: { status: 'up' } })),
    objectStorage: vi.fn(async () => ({ storage: { status: 'up' } })),
  } as unknown as HealthIndicators;
  const health = {
    check: vi.fn(async (fns: HealthIndicatorFunction[]) =>
      Promise.all((fns as (() => Promise<unknown>)[]).map((f) => f())),
    ),
  } as unknown as HealthCheckService;
  return {
    controller: new HealthController(health, indicators),
    indicators,
  };
}

describe('HealthController', () => {
  it('checks database, authenticated redis and storage', async () => {
    const { controller, indicators } = setup();
    const results = (await controller.check()) as unknown as unknown[];
    expect(results).toHaveLength(3);
    expect(indicators.objectStorage).toHaveBeenCalled();
  });

  it('liveness does not touch dependencies', () => {
    const { controller, indicators } = setup();
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(indicators.database).not.toHaveBeenCalled();
  });
});
