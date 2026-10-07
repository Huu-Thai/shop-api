import {
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import {
  API_KEY_HEADER,
  API_PREFIX,
  SWAGGER_PATH,
} from './common/constants/api.constants.js';
import type { AppConfig } from './config/configuration.js';

/** Applies the HTTP pipeline. Shared by main.ts and the e2e tests so both run the same app. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<AppConfig, true>);

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: undefined });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();
  const origins = config.get('corsOrigins', { infer: true });
  app.enableCors({
    origin: origins.length ? origins : false,
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      API_KEY_HEADER,
      'x-request-id',
      'x-store',
      'x-currency',
      'accept-language',
      'idempotency-key',
    ],
    exposedHeaders: ['x-request-id', 'etag'],
  });

  if (config.get('swagger', { infer: true }).enabled) {
    const swaggerUiOptions = {
      jsonDocumentUrl: `${SWAGGER_PATH}-json`,
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        tagsSorter: 'alpha',
        operationsSorter: 'method',
      },
    };

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Shop API')
        .setDescription(
          'Headless commerce & CMS: catalog, pricing, inventory, content, marketing, checkout. Admin endpoints under /admin, storefront under /store.',
        )
        .setVersion(process.env.npm_package_version ?? '0.1.0')
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Admin access token from POST /admin/auth/login',
          },
          'admin-jwt',
        )
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Customer access token from POST /store/account/login (storefront)',
          },
          'customer',
        )
        .addApiKey(
          {
            type: 'apiKey',
            name: API_KEY_HEADER,
            in: 'header',
            description: 'Integration API key (scoped permissions)',
          },
          'api-key',
        )
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document, swaggerUiOptions);
  }
}
