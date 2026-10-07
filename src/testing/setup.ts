import { Logger } from '@nestjs/common';

// Unit tests assert behaviour, not console output; error-path logs are expected noise.
Logger.overrideLogger(false);

// Cheap scrypt for unit tests (read when password.ts is first imported).
process.env.PASSWORD_SCRYPT_N ??= '1024';

// Placeholder environment so modules that validate config at import time can be loaded.
// Unit tests never connect to these; e2e tests replace them with Testcontainers endpoints.
for (const [k, v] of Object.entries({
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit',
  REDIS_HOST: '127.0.0.1',
  REDIS_PASSWORD: 'unit-test-redis-password',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789-abcdef',
  S3_BUCKET: 'unit',
  S3_ACCESS_KEY_ID: 'unit',
  S3_SECRET_ACCESS_KEY: 'unit-secret',
}))
  process.env[k] ??= v;
