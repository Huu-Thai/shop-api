import { UrlRewritesRebuildJob } from './url-rewrites.jobs.js';
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UrlCollisionListener } from './url-collision.listener.js';
import { UrlRewritesController } from './url-rewrites.admin.controller.js';
import { UrlRewritesListener } from './url-rewrites.listener.js';
import { UrlRewritesQuery } from './url-rewrites.query.js';
import { UrlRewritesService } from './url-rewrites.service.js';

/** Storefront URLs per store and locale, generated from catalog events; custom redirects. */
@Module({
  imports: [CatalogModule, ProductsModule],
  controllers: [UrlRewritesController],
  providers: [
    UrlRewritesRebuildJob,
    UrlRewritesService,
    UrlRewritesQuery,
    UrlRewritesListener,
    UrlCollisionListener,
  ],
  exports: [UrlRewritesService, UrlRewritesQuery],
})
export class UrlRewritesModule {}
