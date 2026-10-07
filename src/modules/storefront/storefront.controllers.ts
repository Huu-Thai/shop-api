import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import {
  CacheTag,
  ResponseCache,
  Storefront,
} from '../stores/context/storefront.decorator.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import {
  CategoryProductsQueryDto,
  ResolveUrlQueryDto,
  StorefrontCategoryDto,
  StorefrontCategoryNodeDto,
  StorefrontProductDto,
  StorefrontProductListDto,
  StorefrontUrlResolutionDto,
} from './dto/storefront.dto.js';
import { StorefrontCatalogService } from './storefront-catalog.service.js';

@Storefront('categories')
@CacheTag('category')
@Controller('store/categories')
export class StorefrontCategoriesController {
  constructor(private readonly catalog: StorefrontCatalogService) {}

  @Get()
  @ResponseCache()
  @ApiOperation({
    summary:
      'Category tree of the store (active, assigned to the website, localized)',
    operationId: 'getCategoryTree',
  })
  @ApiOkResponse({ type: [StorefrontCategoryNodeDto] })
  tree(@StoreCtx() ctx: StoreContext) {
    return this.catalog.categoryTree(ctx);
  }

  @Get(':id')
  @ResponseCache()
  @ApiOperation({ summary: 'One category', operationId: 'getCategory' })
  @ApiOkResponse({ type: StorefrontCategoryDto })
  get(@StoreCtx() ctx: StoreContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.category(ctx, id);
  }

  @Get(':id/products')
  @CacheTag('product')
  @ApiOperation({
    summary:
      'Products of a category (with subcategories by default), filtered and sorted',
    operationId: 'listCategoryProducts',
  })
  @ApiOkResponse({ type: StorefrontProductListDto })
  products(
    @StoreCtx() ctx: StoreContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CategoryProductsQueryDto,
  ) {
    return this.catalog.categoryProducts(ctx, id, q);
  }
}

@Storefront('products')
@CacheTag('product')
@Controller('store/products')
export class StorefrontProductsController {
  constructor(private readonly catalog: StorefrontCatalogService) {}

  @Get('by-slug/:slug')
  @ApiOperation({
    summary: 'Product page by URL key in the request locale',
    operationId: 'getProductBySlug',
  })
  @ApiOkResponse({ type: StorefrontProductDto })
  bySlug(@StoreCtx() ctx: StoreContext, @Param('slug') slug: string) {
    return this.catalog.productBySlug(ctx, slug);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Product page: texts, attributes, images, options matrix, bundle, related',
    operationId: 'getProduct',
  })
  @ApiOkResponse({ type: StorefrontProductDto })
  get(@StoreCtx() ctx: StoreContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.product(ctx, id);
  }
}

@Storefront('urls')
@Controller('store/url-resolver')
export class StorefrontUrlController {
  constructor(private readonly catalog: StorefrontCatalogService) {}

  @Get()
  @ApiOperation({
    summary:
      'What lives at a storefront path (product, category, page, blog post, redirect)',
    operationId: 'resolveUrl',
  })
  @ApiOkResponse({ type: StorefrontUrlResolutionDto })
  resolve(@StoreCtx() ctx: StoreContext, @Query() q: ResolveUrlQueryDto) {
    return this.catalog.resolve(ctx, q.path);
  }
}
