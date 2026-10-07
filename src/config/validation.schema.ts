import Joi from 'joi';

const bool = () => Joi.boolean().truthy('true').falsy('false');

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  // Payment providers call back here (webhooks / IPN); required in production.
  API_PUBLIC_URL: Joi.when('NODE_ENV', {
    is: 'production',
    // oxlint-disable-next-line unicorn/no-thenable -- Joi's conditional API uses `then`
    then: Joi.string()
      .uri({ scheme: ['https'] })
      .required(),
    otherwise: Joi.string()
      .uri({ scheme: ['http', 'https'] })
      .optional(),
  }),
  // Comma-separated origins allowed by CORS (storefront themes, admin console). Empty = same-origin only.
  CORS_ORIGINS: Joi.string().allow('').default(''),

  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .default('info'),
  LOG_FORMAT: Joi.string().valid('json', 'pretty').allow('').optional(),
  LOG_TO_FILE: bool().default(false),
  LOG_DIR: Joi.string().default('logs'),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  // Connections per process, and how long a query may wait for one (then it fails instead of hanging).
  DATABASE_POOL_MAX: Joi.number().integer().min(2).max(200).default(20),
  DATABASE_POOL_TIMEOUT_MS: Joi.number()
    .integer()
    .min(500)
    .max(120_000)
    .default(10_000),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_USERNAME: Joi.string().allow('').optional(),
  // Password is mandatory in every environment; production also enforces a minimum length.
  REDIS_PASSWORD: Joi.string()
    .required()
    .when('NODE_ENV', {
      is: 'production',
      // oxlint-disable-next-line unicorn/no-thenable -- Joi's conditional API uses `then`
      then: Joi.string().min(16),
      otherwise: Joi.string().min(1),
    })
    .messages({
      'any.required':
        'REDIS_PASSWORD is required — the service never connects to Redis without authentication',
      'string.min':
        'REDIS_PASSWORD must be at least {#limit} characters in this environment',
    }),
  REDIS_TLS: bool().default(false),
  REDIS_QUEUE_DB: Joi.number().integer().min(0).max(15).default(0),
  REDIS_CACHE_DB: Joi.number().integer().min(0).max(15).default(1),

  // ─── Admin authentication ───
  AUTH_JWT_SECRET: Joi.string().min(32).required().messages({
    'string.min':
      'AUTH_JWT_SECRET must be at least 32 characters (openssl rand -hex 32)',
  }),
  AUTH_JWT_ISSUER: Joi.string().default('shop'),
  AUTH_ACCESS_TTL_S: Joi.number().integer().min(60).max(86_400).default(900),
  AUTH_REFRESH_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),
  // Failed logins before a temporary lock, and the lock length.
  AUTH_MAX_FAILED_LOGINS: Joi.number().integer().min(3).max(50).default(5),
  // scrypt cost; only tests may lower it (production enforces the OWASP minimum).
  // (`.valid()` is an allow-list that bypasses other rules, so each environment gets its own list.)
  PASSWORD_SCRYPT_N: Joi.number()
    .integer()
    .when('NODE_ENV', {
      is: 'production',
      // oxlint-disable-next-line unicorn/no-thenable -- Joi's conditional API uses `then`
      then: Joi.valid(131072, 262144),
      otherwise: Joi.valid(
        1024,
        2048,
        4096,
        8192,
        16384,
        32768,
        65536,
        131072,
        262144,
      ),
    })
    .optional(),
  AUTH_LOCKOUT_MINUTES: Joi.number().integer().min(1).max(1_440).default(15),

  S3_ENDPOINT: Joi.string().uri().allow('').optional(),
  // Signed links (export downloads, private media) use this endpoint when S3_ENDPOINT is internal.
  S3_PUBLIC_ENDPOINT: Joi.string().uri().allow('').optional(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_BUCKET: Joi.string().required(),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: bool().default(false),
  S3_SSE: Joi.string().valid('', 'AES256', 'aws:kms').default(''),
  S3_SIGNED_URL_TTL: Joi.number().integer().min(30).max(3600).default(300),

  // 32-byte key (64 hex chars or base64) sealing stored secrets (search engine credentials, later
  // payment providers). Required before such secrets can be saved. Rotating it needs a re-seal.
  APP_ENCRYPTION_KEY: Joi.string()
    .pattern(/^([0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/)
    .allow('')
    .optional()
    .messages({
      'string.pattern.base':
        'APP_ENCRYPTION_KEY must be 32 bytes as 64 hex chars or base64 (openssl rand -hex 32)',
    }),

  // Public origin (CDN) serving the media bucket; empty → signed URLs.
  MEDIA_PUBLIC_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  MEDIA_MAX_UPLOAD_MB: Joi.number().integer().min(1).max(100).default(20),

  // Delay before a replaced search engine's indexes are dropped (in-flight reads finish first).
  SEARCH_DROP_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(86_400_000)
    .default(60_000),

  OUTBOX_RELAY_ENABLED: bool().default(true),
  OUTBOX_RELAY_INTERVAL_MS: Joi.number()
    .integer()
    .min(500)
    .max(300_000)
    .default(5_000),
  OUTBOX_GRACE_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(10),

  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(300),
  // Stricter budget for login / token refresh (per IP + email).
  THROTTLE_AUTH_LIMIT: Joi.number().integer().min(1).default(10),

  SWAGGER_ENABLED: bool().default(true),
  WORKER_QUEUES: Joi.string().allow('').optional(),

  // ─── Jobs, imports and exports ───
  JOBS_CONCURRENCY: Joi.number().integer().min(1).max(16).default(2),
  // Export and import files are deleted after this many days; execution history after JOBS_HISTORY_DAYS.
  JOBS_FILE_RETENTION_DAYS: Joi.number().integer().min(1).max(365).default(7),
  JOBS_HISTORY_DAYS: Joi.number().integer().min(1).max(3650).default(90),
  IMPORT_MAX_MB: Joi.number().integer().min(1).max(200).default(50),

  // ─── Audit log and outgoing webhooks ───
  // Audit rows older than this are deleted daily; 0 keeps them forever.
  AUDIT_RETENTION_DAYS: Joi.number().integer().min(0).max(3650).default(365),
  WEBHOOK_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(30_000)
    .default(10_000),
  WEBHOOK_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(10),
  // Consecutive failed deliveries (each after all retries) before a webhook is switched off.
  WEBHOOK_DISABLE_AFTER: Joi.number().integer().min(1).max(1000).default(20),
  WEBHOOK_DELIVERY_RETENTION_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(365)
    .default(30),
  // Webhooks to private / loopback addresses are refused unless allowed (local development).
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool().default(false),

  // Anonymous storefront GETs are served from Redis for up to this long (purged on catalog changes;
  // stays within the max-age=60 sent to CDNs). 0 = off.
  STOREFRONT_CACHE_TTL_S: Joi.number().integer().min(0).max(60).default(30),

  // ─── Metrics (Prometheus) ───
  // Bearer token required on GET /metrics; empty = no token (keep the endpoint off the internet).
  METRICS_TOKEN: Joi.when('NODE_ENV', {
    is: 'production',
    // oxlint-disable-next-line unicorn/no-thenable -- Joi's conditional API uses `then`
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }).messages({
    'any.required':
      'METRICS_TOKEN is required in production (openssl rand -hex 24)',
  }),
  // The worker serves its own /metrics on this port (0 = off).
  WORKER_METRICS_PORT: Joi.number().integer().min(0).max(65535).default(9464),
});

/**
 * Validates the raw environment, reporting every problem at once. Throwing here
 * aborts bootstrap, so a misconfigured process never starts.
 */
export function validateEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const { error, value } = validationSchema.validate(env, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });
  if (error) {
    const details = error.details.map((d) => `  - ${d.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return value as Record<string, unknown>;
}
