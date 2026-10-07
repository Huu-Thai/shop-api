import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProductsModule } from '../products/products.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { CartPricer } from './cart-pricer.js';
import { CartsController } from './carts.controller.js';
import { CartsService } from './carts.service.js';

/** Carts and their pricing (PLAN.md §7.1): guest tokens, customer carts, merge on sign-in. */
@Module({
  imports: [
    ProductsModule,
    PricingModule,
    InventoryModule,
    ShippingModule,
    MarketingModule,
    LoyaltyModule,
  ],
  controllers: [CartsController],
  providers: [CartsService, CartPricer],
  exports: [CartsService, CartPricer],
})
export class CartsModule {}
