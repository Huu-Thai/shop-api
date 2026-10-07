import {
  ExportPricesJob,
  ImportPricesJob,
  PricesReindexJob,
} from './pricing.jobs.js';
import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { PriceBooksService } from './price-books.service.js';
import { PriceIndexListener } from './price-index.listener.js';
import { PriceIndexer } from './price-indexer.js';
import { PricingController } from './pricing.controller.js';
import { PricingQuery } from './pricing.query.js';

/** Price books, tier prices, exchange rates and the price index (PLAN.md §9). */
@Module({
  imports: [ProductsModule],
  controllers: [PricingController],
  providers: [
    PricesReindexJob,
    ExportPricesJob,
    ImportPricesJob,
    PriceBooksService,
    PriceIndexer,
    PricingQuery,
    PriceIndexListener,
  ],
  exports: [PricingQuery, PriceIndexer],
})
export class PricingModule {}
