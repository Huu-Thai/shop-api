import { Module } from '@nestjs/common';
import { CmsModule } from '../cms/cms.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { MediaModule } from '../media/media.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UrlRewritesModule } from '../url-rewrites/url-rewrites.module.js';
import { StorefrontCatalogService } from './storefront-catalog.service.js';
import {
  StorefrontCategoriesController,
  StorefrontProductsController,
  StorefrontUrlController,
} from './storefront.controllers.js';

/**
 * Storefront read models (`/api/v1/store/*`): composes the read-only *Query services of the catalog
 * modules into page-shaped responses. Owns no tables and never writes.
 */
@Module({
  imports: [
    CatalogModule,
    ProductsModule,
    MediaModule,
    UrlRewritesModule,
    PricingModule,
    InventoryModule,
    CmsModule,
  ],
  controllers: [
    StorefrontCategoriesController,
    StorefrontProductsController,
    StorefrontUrlController,
  ],
  providers: [StorefrontCatalogService],
  exports: [StorefrontCatalogService],
})
export class StorefrontModule {}
