export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  /** Public origin of this API (payment notification URLs), e.g. https://api.shop.example. */
  publicUrl: string;
  corsOrigins: string[];
  log: {
    level: string;
    format: 'json' | 'pretty';
    toFile: boolean;
    dir: string;
  };
  database: {
    url: string;
    /** Connections per process (API replicas × pool + workers × pool ≤ Postgres max_connections). */
    poolMax: number;
    /** How long a query waits for a free connection before failing. */
    poolTimeoutMs: number;
  };
  redis: {
    host: string;
    port: number;
    username?: string;
    password: string;
    tls: boolean;
    queueDb: number;
    cacheDb: number;
  };
  auth: {
    jwtSecret: string;
    issuer: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    maxFailedLogins: number;
    lockoutMinutes: number;
  };
  s3: {
    endpoint?: string;
    /** Endpoint browsers reach for signed links, when `endpoint` is internal (compose, VPC). */
    publicEndpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    signedUrlTtl: number;
    serverSideEncryption?: 'AES256' | 'aws:kms';
  };
  media: {
    /** CDN / public origin in front of the bucket; without it the storefront gets signed URLs. */
    publicBaseUrl?: string;
    maxUploadBytes: number;
  };
  search: { dropDelayMs: number };
  /** Seals stored secrets; undefined until APP_ENCRYPTION_KEY is configured. */
  encryptionKey?: string;
  processRole: 'api' | 'worker';
  outbox: {
    relayEnabled: boolean;
    relayIntervalMs: number;
    graceMs: number;
    maxAttempts: number;
  };
  throttle: { ttlMs: number; limit: number; authLimit: number };
  swagger: { enabled: boolean };
  worker: { queues: string[] };
  jobs: {
    concurrency: number;
    fileRetentionDays: number;
    historyDays: number;
    importMaxBytes: number;
  };
  audit: { retentionDays: number };
  webhooks: {
    timeoutMs: number;
    maxAttempts: number;
    disableAfter: number;
    retentionDays: number;
    allowPrivateTargets: boolean;
  };
  metrics: { token?: string; workerPort: number };
  /** Server-side cache of anonymous storefront GETs; 0 turns it off. */
  storefrontCache: { ttlSeconds: number };
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const int = (value: string | undefined, fallback: number) =>
  value === undefined || value === '' ? fallback : parseInt(value, 10);

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : value === 'true';

export default (): AppConfig => {
  const env = (process.env.NODE_ENV ?? 'development') as AppConfig['env'];
  return {
    env,
    port: int(process.env.PORT, 3000),
    publicUrl: (
      process.env.API_PUBLIC_URL ||
      `http://localhost:${int(process.env.PORT, 3000)}`
    ).replace(/\/+$/, ''),
    corsOrigins: list(process.env.CORS_ORIGINS),
    log: {
      level: process.env.LOG_LEVEL ?? 'info',
      format: (process.env.LOG_FORMAT ||
        (env === 'production' ? 'json' : 'pretty')) as 'json' | 'pretty',
      toFile: flag(process.env.LOG_TO_FILE, false),
      dir: process.env.LOG_DIR ?? 'logs',
    },
    database: {
      url: process.env.DATABASE_URL ?? '',
      poolMax: int(process.env.DATABASE_POOL_MAX, 20),
      poolTimeoutMs: int(process.env.DATABASE_POOL_TIMEOUT_MS, 10_000),
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: int(process.env.REDIS_PORT, 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD ?? '',
      tls: flag(process.env.REDIS_TLS, false),
      queueDb: int(process.env.REDIS_QUEUE_DB, 0),
      cacheDb: int(process.env.REDIS_CACHE_DB, 1),
    },
    auth: {
      jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
      issuer: process.env.AUTH_JWT_ISSUER || 'shop',
      accessTtlSeconds: int(process.env.AUTH_ACCESS_TTL_S, 900),
      refreshTtlDays: int(process.env.AUTH_REFRESH_TTL_DAYS, 30),
      maxFailedLogins: int(process.env.AUTH_MAX_FAILED_LOGINS, 5),
      lockoutMinutes: int(process.env.AUTH_LOCKOUT_MINUTES, 15),
    },
    encryptionKey: process.env.APP_ENCRYPTION_KEY || undefined,
    search: { dropDelayMs: int(process.env.SEARCH_DROP_DELAY_MS, 60_000) },
    media: {
      publicBaseUrl:
        process.env.MEDIA_PUBLIC_BASE_URL?.replace(/\/+$/, '') || undefined,
      maxUploadBytes: int(process.env.MEDIA_MAX_UPLOAD_MB, 20) * 1024 * 1024,
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT || undefined,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'us-east-1',
      bucket: process.env.S3_BUCKET ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: flag(process.env.S3_FORCE_PATH_STYLE, false),
      signedUrlTtl: int(process.env.S3_SIGNED_URL_TTL, 300),
      serverSideEncryption: (process.env.S3_SSE ||
        undefined) as AppConfig['s3']['serverSideEncryption'],
    },
    processRole: process.env.PROCESS_ROLE === 'worker' ? 'worker' : 'api',
    outbox: {
      relayEnabled: flag(process.env.OUTBOX_RELAY_ENABLED, true),
      relayIntervalMs: int(process.env.OUTBOX_RELAY_INTERVAL_MS, 5_000),
      graceMs: int(process.env.OUTBOX_GRACE_MS, 30_000),
      maxAttempts: int(process.env.OUTBOX_MAX_ATTEMPTS, 10),
    },
    throttle: {
      ttlMs: int(process.env.THROTTLE_TTL_MS, 60_000),
      limit: int(process.env.THROTTLE_LIMIT, 300),
      authLimit: int(process.env.THROTTLE_AUTH_LIMIT, 10),
    },
    swagger: { enabled: flag(process.env.SWAGGER_ENABLED, true) },
    worker: { queues: list(process.env.WORKER_QUEUES) },
    jobs: {
      concurrency: int(process.env.JOBS_CONCURRENCY, 2),
      fileRetentionDays: int(process.env.JOBS_FILE_RETENTION_DAYS, 7),
      historyDays: int(process.env.JOBS_HISTORY_DAYS, 90),
      importMaxBytes: int(process.env.IMPORT_MAX_MB, 50) * 1024 * 1024,
    },
    audit: { retentionDays: int(process.env.AUDIT_RETENTION_DAYS, 365) },
    webhooks: {
      timeoutMs: int(process.env.WEBHOOK_TIMEOUT_MS, 10_000),
      maxAttempts: int(process.env.WEBHOOK_MAX_ATTEMPTS, 10),
      disableAfter: int(process.env.WEBHOOK_DISABLE_AFTER, 20),
      retentionDays: int(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS, 30),
      allowPrivateTargets: flag(
        process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
        false,
      ),
    },
    storefrontCache: {
      ttlSeconds: int(process.env.STOREFRONT_CACHE_TTL_S, 30),
    },
    metrics: {
      token: process.env.METRICS_TOKEN || undefined,
      workerPort: int(process.env.WORKER_METRICS_PORT, 9464),
    },
  };
};
