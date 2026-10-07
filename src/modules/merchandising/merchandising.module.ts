import { Module } from '@nestjs/common';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { MediaModule } from '../media/media.module.js';
import { BannersService } from './banners.service.js';
import {
  BannersController,
  SlidersController,
  StorefrontBannersController,
  StorefrontSlidersController,
} from './merchandising.controllers.js';
import { MerchandisingListener } from './merchandising.listener.js';
import { MerchandisingQuery } from './merchandising.query.js';
import { SlidersService } from './sliders.service.js';

/** Merchandising content (PLAN.md §9 & §14 Phase 4): scheduled banners and sliders. */
@Module({
  imports: [MediaModule],
  controllers: [
    BannersController,
    SlidersController,
    StorefrontBannersController,
    StorefrontSlidersController,
  ],
  providers: [
    ContentPublisher,
    BannersService,
    SlidersService,
    MerchandisingQuery,
    MerchandisingListener,
  ],
})
export class MerchandisingModule {}
