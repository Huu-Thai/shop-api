import { Global, Module } from '@nestjs/common';
import { StoreContextGuard } from './context/store-context.guard.js';
import { StorefrontCacheInterceptor } from './context/storefront-cache.interceptor.js';
import { StorefrontResponseCache } from './context/storefront-response-cache.js';
import { ReferenceDataService } from './reference-data.service.js';
import {
  ReferenceDataController,
  WebsitesStoresController,
} from './stores.admin.controller.js';
import { StoresCacheListener } from './stores-cache.listener.js';
import { StoresQuery } from './stores.query.js';
import { StoresService } from './stores.service.js';
import { StorefrontConfigController } from './storefront-config.controller.js';
import { WebsitesService } from './websites.service.js';

/**
 * Websites, stores, locales and currencies, plus the storefront scope (StoreContext). Global so
 * every storefront controller can use @Storefront() and every module can read StoresQuery.
 */
@Global()
@Module({
  controllers: [
    ReferenceDataController,
    WebsitesStoresController,
    StorefrontConfigController,
  ],
  providers: [
    ReferenceDataService,
    WebsitesService,
    StoresService,
    StoresQuery,
    StoresCacheListener,
    StoreContextGuard,
    StorefrontCacheInterceptor,
    StorefrontResponseCache,
  ],
  exports: [
    StoresQuery,
    StoreContextGuard,
    StorefrontCacheInterceptor,
    StorefrontResponseCache,
  ],
})
export class StoresModule {}
