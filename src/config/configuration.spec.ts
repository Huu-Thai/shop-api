import configuration from './configuration.js';

describe('configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('maps the environment into typed settings', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGINS: 'https://shop.example, https://admin.example ,',
      LOG_FORMAT: '',
      THROTTLE_AUTH_LIMIT: '7',
      WORKER_QUEUES: 'media, search-index',
      SWAGGER_ENABLED: 'false',
      REDIS_USERNAME: '',
    });
    const c = configuration();
    expect(c.port).toBe(8080);
    expect(c.corsOrigins).toEqual([
      'https://shop.example',
      'https://admin.example',
    ]);
    expect(c.log.format).toBe('json');
    expect(c.throttle.authLimit).toBe(7);
    expect(c.worker.queues).toEqual(['media', 'search-index']);
    expect(c.swagger.enabled).toBe(false);
    expect(c.redis.username).toBeUndefined();
  });

  it('defaults sensibly in development', () => {
    for (const k of [
      'NODE_ENV',
      'PORT',
      'LOG_FORMAT',
      'CORS_ORIGINS',
      'AUTH_ACCESS_TTL_S',
      'WORKER_QUEUES',
    ])
      delete process.env[k];
    const c = configuration();
    expect(c).toMatchObject({
      env: 'development',
      port: 3000,
      corsOrigins: [],
      log: { format: 'pretty' },
      auth: { accessTtlSeconds: 900 },
      worker: { queues: [] },
    });
  });
});
