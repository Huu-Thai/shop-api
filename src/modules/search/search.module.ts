import { SearchReindexJob } from './search.jobs.js';
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ProductsModule } from '../products/products.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { UrlRewritesModule } from '../url-rewrites/url-rewrites.module.js';
import { PostgresSearchProvider } from './providers/postgres.provider.js';
import { SearchProviders } from './providers/registry.js';
import { SearchEngines } from './search-engines.service.js';
import { SearchIndexer } from './search-indexer.js';
import { SearchSettingsQuery } from './search-settings.query.js';
import { SearchSettingsService } from './search-settings.service.js';
import {
  SearchAdminController,
  StorefrontSearchController,
} from './search.controllers.js';
import { SearchListener } from './search.listener.js';
import { SearchService } from './search.service.js';

/** Search (PLAN.md §9.5): documents, engines (Postgres default), switching and storefront search. */
@Module({
  imports: [CatalogModule, ProductsModule, StorefrontModule, UrlRewritesModule],
  controllers: [StorefrontSearchController, SearchAdminController],
  providers: [
    SearchReindexJob,
    PostgresSearchProvider,
    SearchProviders,
    SearchSettingsQuery,
    SearchSettingsService,
    SearchIndexer,
    SearchEngines,
    SearchService,
    SearchListener,
  ],
  exports: [SearchIndexer, SearchEngines],
})
export class SearchModule {}
