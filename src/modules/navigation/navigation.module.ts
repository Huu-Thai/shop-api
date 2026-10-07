import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CmsModule } from '../cms/cms.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UrlRewritesModule } from '../url-rewrites/url-rewrites.module.js';
import {
  MenusController,
  StorefrontMenusController,
} from './navigation.controllers.js';
import { NavigationListener } from './navigation.listener.js';
import { MenusQuery } from './menus.query.js';
import { MenusService } from './menus.service.js';

/** Navigation menus (PLAN.md §9 & §14 Phase 4). */
@Module({
  imports: [CmsModule, CatalogModule, ProductsModule, UrlRewritesModule],
  controllers: [MenusController, StorefrontMenusController],
  providers: [MenusService, MenusQuery, NavigationListener],
})
export class NavigationModule {}
