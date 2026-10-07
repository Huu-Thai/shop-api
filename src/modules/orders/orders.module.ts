import { ExportOrdersJob } from './orders.jobs.js';
import { Module } from '@nestjs/common';
import { CartsModule } from '../carts/carts.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import {
  OrdersAdminController,
  StorefrontOrdersController,
} from './orders.controllers.js';
import { OrdersListener } from './orders.listener.js';
import { OrdersQuery } from './orders.query.js';
import { OrdersService } from './orders.service.js';

/** Orders (PLAN.md §3.2, §4): placement, lifecycle, shipments, invoices and credit memos. */
@Module({
  imports: [CartsModule, InventoryModule, LoyaltyModule, MarketingModule],
  controllers: [StorefrontOrdersController, OrdersAdminController],
  providers: [OrdersService, OrdersQuery, OrdersListener, ExportOrdersJob],
  exports: [OrdersService, OrdersQuery],
})
export class OrdersModule {}
