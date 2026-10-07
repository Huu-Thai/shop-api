import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthCoreModule } from './common/auth/auth-core.module.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { PrincipalThrottlerGuard } from './common/auth/throttler.guard.js';
import { CryptoModule } from './common/crypto/crypto.module.js';
import { EventsModule } from './common/events/events.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { AppConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/configuration.js';
import { PrismaModule } from './database/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { LoggerModule } from './logger/logger.module.js';
import {
  AdminModule,
  AuditRecorderModule,
} from './modules/admin/admin.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { TaxModule } from './modules/tax/tax.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { CartsModule } from './modules/carts/carts.module.js';
import { CmsModule } from './modules/cms/cms.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ShippingModule } from './modules/shipping/shipping.module.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { MarketingModule } from './modules/marketing/marketing.module.js';
import { MerchandisingModule } from './modules/merchandising/merchandising.module.js';
import { NavigationModule } from './modules/navigation/navigation.module.js';
import { SchedulerModule } from './modules/scheduler/scheduler.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { StorefrontModule } from './modules/storefront/storefront.module.js';
import { StoresModule } from './modules/stores/stores.module.js';
import { UrlRewritesModule } from './modules/url-rewrites/url-rewrites.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';

/** Infrastructure shared by the API and the worker processes. */
export const CORE_IMPORTS = [
  AppConfigModule,
  LoggerModule,
  PrismaModule,
  RedisModule,
  QueueModule,
  StorageModule,
  EventsModule,
  AuthCoreModule,
  AuditRecorderModule,
  CryptoModule,
];

/** Domain modules; the worker imports them too, for its processors and listeners. */
export const DOMAIN_IMPORTS = [
  StoresModule,
  CatalogModule,
  ProductsModule,
  MediaModule,
  UrlRewritesModule,
  CustomersModule,
  TaxModule,
  PricingModule,
  InventoryModule,
  SearchModule,
  SchedulerModule,
  CmsModule,
  NavigationModule,
  MerchandisingModule,
  MarketingModule,
  LoyaltyModule,
  ShippingModule,
  CartsModule,
  OrdersModule,
  ReportsModule,
  PaymentsModule,
  JobsModule,
  WebhooksModule,
];

@Module({
  imports: [
    ...CORE_IMPORTS,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const { ttlMs, limit } = config.get('throttle', { infer: true });
        return [{ ttl: ttlMs, limit }];
      },
    }),
    HealthModule,
    MetricsModule.forRole('api'),
    AdminModule,
    ...DOMAIN_IMPORTS,
    StorefrontModule,
  ],
  providers: [
    // Order matters: authenticate first (so rate limits are per principal), then rate-limit.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
