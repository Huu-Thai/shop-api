import { ExportStockJob, ImportStockJob } from './inventory.jobs.js';
import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryQuery } from './inventory.query.js';
import { InventoryService } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

/** Multi-source inventory: stock, reservations and the ledger (PLAN.md §3.2, §9). */
@Module({
  imports: [ProductsModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    ReservationsService,
    InventoryQuery,
    ExportStockJob,
    ImportStockJob,
  ],
  exports: [InventoryQuery, ReservationsService],
})
export class InventoryModule {}
