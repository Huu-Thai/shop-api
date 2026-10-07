import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import type { AppConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  // rawBody: payment webhooks verify signatures over the exact bytes received.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  configureApp(app);
  const port = app
    .get(ConfigService<AppConfig, true>)
    .get('port', { infer: true });
  await app.listen(port);
}

await bootstrap();
