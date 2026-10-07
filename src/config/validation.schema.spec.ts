import { validateEnv } from './validation.schema.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@db:5432/shop',
  REDIS_HOST: 'redis',
  REDIS_PASSWORD: 'a-long-redis-password',
  AUTH_JWT_SECRET: 'x'.repeat(32),
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('validateEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      AUTH_ACCESS_TTL_S: 900,
      THROTTLE_AUTH_LIMIT: 10,
      SWAGGER_ENABLED: true,
    });
  });

  it('never allows Redis without a password', () => {
    const { REDIS_PASSWORD: _, ...rest } = base;
    expect(() => validateEnv(rest)).toThrow('REDIS_PASSWORD is required');
    expect(() => validateEnv({ ...base, REDIS_PASSWORD: '' })).toThrow(
      'REDIS_PASSWORD',
    );
  });

  it('applies production minimums to secrets and scrypt cost', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => validateEnv({ ...prod, REDIS_PASSWORD: 'short' })).toThrow(
      'at least 16',
    );
    expect(() => validateEnv({ ...prod, PASSWORD_SCRYPT_N: '1024' })).toThrow(
      'PASSWORD_SCRYPT_N',
    );
    expect(
      validateEnv({ ...base, NODE_ENV: 'test', PASSWORD_SCRYPT_N: '1024' })
        .PASSWORD_SCRYPT_N,
    ).toBe(1024);
    expect(() => validateEnv({ ...base, PASSWORD_SCRYPT_N: '1000' })).toThrow(
      'PASSWORD_SCRYPT_N',
    );
  });

  it('needs an https public API URL in production (payment notifications)', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      REDIS_PASSWORD: 'x'.repeat(16),
    };
    expect(() => validateEnv(prod)).toThrow('API_PUBLIC_URL');
    expect(() =>
      validateEnv({ ...prod, API_PUBLIC_URL: 'http://api.shop.example' }),
    ).toThrow('API_PUBLIC_URL');
    expect(
      validateEnv({ ...base, API_PUBLIC_URL: 'http://localhost:3300' })
        .API_PUBLIC_URL,
    ).toBe('http://localhost:3300');
  });

  it('protects metrics in production and defaults the Phase 7 settings', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      REDIS_PASSWORD: 'x'.repeat(16),
      API_PUBLIC_URL: 'https://api.shop.example',
    };
    expect(() => validateEnv(prod)).toThrow('METRICS_TOKEN is required');
    expect(() => validateEnv({ ...prod, METRICS_TOKEN: 'short' })).toThrow(
      'METRICS_TOKEN',
    );
    expect(
      validateEnv({ ...prod, METRICS_TOKEN: 'x'.repeat(24) }),
    ).toMatchObject({
      JOBS_CONCURRENCY: 2,
      JOBS_FILE_RETENTION_DAYS: 7,
      AUDIT_RETENTION_DAYS: 365,
      WEBHOOK_MAX_ATTEMPTS: 10,
      WEBHOOK_ALLOW_PRIVATE_TARGETS: false,
      WORKER_METRICS_PORT: 9464,
    });
    expect(validateEnv(base).METRICS_TOKEN).toBeUndefined();
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      validateEnv({ AUTH_JWT_SECRET: 'short' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const k of [
      'DATABASE_URL',
      'REDIS_HOST',
      'REDIS_PASSWORD',
      'AUTH_JWT_SECRET',
      'S3_BUCKET',
    ])
      expect(message).toContain(k);
  });
});
