import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { prisma } from './migrate.js';

export const REDIS_PASSWORD = 'e2e-redis-password-0123456789';
const MINIO = {
  user: 'e2e-access',
  password: 'e2e-secret-0123456789',
  bucket: 'shop-media-e2e',
};

export interface TestStack {
  redis: StartedRedisContainer;
  stop(): Promise<void>;
}

/** Starts Postgres (migrated), password-protected Redis and MinIO (+bucket), then sets process.env. */
export async function startStack(): Promise<TestStack> {
  const [postgres, redis, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').withPassword(REDIS_PASSWORD).start(),
    new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data'])
      .withEnvironment({
        MINIO_ROOT_USER: MINIO.user,
        MINIO_ROOT_PASSWORD: MINIO.password,
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
      .start(),
  ]);

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO.user, secretAccessKey: MINIO.password },
  });
  await s3.send(new CreateBucketCommand({ Bucket: MINIO.bucket }));
  s3.destroy();

  const databaseUrl = (
    postgres as StartedPostgreSqlContainer
  ).getConnectionUri();
  prisma(['migrate', 'deploy'], databaseUrl);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
    DATABASE_URL: databaseUrl,
    REDIS_HOST: redis.getHost(),
    REDIS_PORT: String(redis.getMappedPort(6379)),
    REDIS_PASSWORD,
    REDIS_USERNAME: '',
    AUTH_JWT_SECRET: 'e2e-jwt-secret-0123456789-0123456789-abcdef',
    // Cheap scrypt in tests only (production enforces the OWASP minimum).
    PASSWORD_SCRYPT_N: '1024',
    // Seals stored engine credentials (test-only key).
    APP_ENCRYPTION_KEY: '0f'.repeat(32),
    SEARCH_DROP_DELAY_MS: '500',
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: MINIO.bucket,
    S3_ACCESS_KEY_ID: MINIO.user,
    S3_SECRET_ACCESS_KEY: MINIO.password,
    S3_FORCE_PATH_STYLE: 'true',
    THROTTLE_LIMIT: '1000',
    THROTTLE_AUTH_LIMIT: '1000',
  });

  return {
    redis,
    async stop() {
      await Promise.all([
        postgres.stop(),
        redis.stop(),
        minio.stop(),
      ] as Promise<unknown>[]);
    },
  };
}

export type { StartedTestContainer };
