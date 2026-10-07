import { Module } from '@nestjs/common';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MediaModule } from '../media/media.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UrlRewritesModule } from '../url-rewrites/url-rewrites.module.js';
import {
  BlocksController,
  PagesController,
  PostsController,
  TagsController,
} from './cms.admin.controller.js';
import { CmsListener } from './cms.listener.js';
import { CmsQuery } from './cms.query.js';
import {
  StorefrontBlocksController,
  StorefrontPagesController,
  StorefrontPostsController,
} from './cms.storefront.controller.js';
import { CmsUrlCollisionListener } from './cms-url-collision.listener.js';
import { CmsUrlsService } from './cms-urls.service.js';
import { BlocksService } from './blocks.service.js';
import { PagesService } from './pages.service.js';
import { PostsService } from './posts.service.js';
import { TagsService } from './tags.service.js';

/** CMS (PLAN.md §9 & §14 Phase 4): pages, blog posts and tags, blocks and their placements. */
@Module({
  imports: [CatalogModule, ProductsModule, MediaModule, UrlRewritesModule],
  controllers: [
    PagesController,
    PostsController,
    TagsController,
    BlocksController,
    StorefrontPagesController,
    StorefrontPostsController,
    StorefrontBlocksController,
  ],
  providers: [
    ContentPublisher,
    PagesService,
    PostsService,
    TagsService,
    BlocksService,
    CmsQuery,
    CmsUrlsService,
    CmsListener,
    CmsUrlCollisionListener,
  ],
  exports: [CmsQuery],
})
export class CmsModule {}
