import { Module } from '@nestjs/common';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { ProductsModule } from '../products/products.module.js';
import { CampaignsService } from './campaigns.service.js';
import { CouponsService } from './coupons.service.js';
import {
  CampaignsController,
  CouponsAndUsageController,
  PromotionsController,
} from './marketing.controllers.js';
import { MarketingListener } from './marketing.listener.js';
import { PromotionsQuery } from './promotions.query.js';
import { PromotionsService } from './promotions.service.js';
import { RedemptionsService } from './redemptions.service.js';

/** Marketing (PLAN.md §3.2, §9): campaigns, cart promotions, coupons and their use by orders. */
@Module({
  imports: [ProductsModule],
  controllers: [
    CampaignsController,
    PromotionsController,
    CouponsAndUsageController,
  ],
  providers: [
    ContentPublisher,
    CampaignsService,
    PromotionsService,
    CouponsService,
    PromotionsQuery,
    RedemptionsService,
    MarketingListener,
  ],
  exports: [RedemptionsService, PromotionsQuery, CouponsService],
})
export class MarketingModule {}
