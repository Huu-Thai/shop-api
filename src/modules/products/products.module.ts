import { ExportProductsJob, ImportProductsJob } from './products.jobs.js';
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AttributeUsageListener } from './attribute-usage.listener.js';
import { BundleOptionsWriter } from './bundle-options.writer.js';
import { ProductImageOwnerListener } from './image-owner.listener.js';
import {
  ProductsController,
  VariantsAdminController,
} from './products.admin.controller.js';
import { ProductsQuery } from './products.query.js';
import { ProductsService } from './products.service.js';
import { VariantsService } from './variants.service.js';

/** Products of every type, their variants, bundles, store overrides and relations. */
@Module({
  imports: [CatalogModule],
  controllers: [ProductsController, VariantsAdminController],
  providers: [
    ProductsService,
    VariantsService,
    BundleOptionsWriter,
    ProductsQuery,
    AttributeUsageListener,
    ProductImageOwnerListener,
    ExportProductsJob,
    ImportProductsJob,
  ],
  exports: [ProductsQuery],
})
export class ProductsModule {}
