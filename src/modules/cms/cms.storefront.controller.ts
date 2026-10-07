import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import {
  CacheTag,
  Storefront,
} from '../stores/context/storefront.decorator.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import { CmsQuery } from './cms.query.js';
import {
  PageByPathQueryDto,
  PlacementsQueryDto,
  StorefrontBlockDto,
  StorefrontPageDto,
  StorefrontPostDto,
  StorefrontPostListDto,
  StorefrontPostsQueryDto,
  StorefrontRegionDto,
} from './dto/storefront-cms.dto.js';

const found = <T>(v: T | undefined, what: string): T => {
  if (!v) throw new NotFoundException(`${what} not found`);
  return v;
};

@Storefront('cms')
@CacheTag('page')
@Controller('store/pages')
export class StorefrontPagesController {
  constructor(private readonly cms: CmsQuery) {}

  @Get('by-path')
  @ApiOperation({
    summary: 'Page at a path (`help/shipping`) in the request locale',
    operationId: 'getPageByPath',
  })
  @ApiOkResponse({ type: StorefrontPageDto })
  async byPath(@StoreCtx() ctx: StoreContext, @Query() q: PageByPathQueryDto) {
    return found(await this.cms.pageByPath(ctx, q.path), 'Page');
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Page with blocks rendered and placed blocks by region',
    operationId: 'getPage',
  })
  @ApiOkResponse({ type: StorefrontPageDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return found(await this.cms.page(ctx, id), 'Page');
  }
}

@Storefront('cms')
@CacheTag('post')
@Controller('store/posts')
export class StorefrontPostsController {
  constructor(private readonly cms: CmsQuery) {}

  @Get()
  @ApiOperation({
    summary: 'Blog posts, newest first (optionally by tag)',
    operationId: 'listPosts',
  })
  @ApiOkResponse({ type: StorefrontPostListDto })
  list(@StoreCtx() ctx: StoreContext, @Query() q: StorefrontPostsQueryDto) {
    return this.cms.posts(ctx, q);
  }

  @Get('by-slug/:slug')
  @ApiOperation({
    summary: 'Blog post by URL key in the request locale',
    operationId: 'getPostBySlug',
  })
  @ApiOkResponse({ type: StorefrontPostDto })
  async bySlug(@StoreCtx() ctx: StoreContext, @Param('slug') slug: string) {
    return found(await this.cms.postBySlug(ctx, slug), 'Post');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Blog post', operationId: 'getPost' })
  @ApiOkResponse({ type: StorefrontPostDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return found(await this.cms.post(ctx, id), 'Post');
  }
}

@Storefront('cms')
@CacheTag('block')
@Controller('store/blocks')
export class StorefrontBlocksController {
  constructor(private readonly cms: CmsQuery) {}

  @Get('placements')
  @ApiOperation({
    summary:
      'Blocks placed on a page, post, category or product, grouped by region',
    operationId: 'getBlockPlacements',
  })
  @ApiOkResponse({ type: [StorefrontRegionDto] })
  placements(@StoreCtx() ctx: StoreContext, @Query() q: PlacementsQueryDto) {
    return this.cms.regions(ctx, q.targetType, q.targetId);
  }

  @Get(':identifier')
  @ApiOperation({
    summary: 'A block by identifier (the store’s own wins), rendered',
    operationId: 'getBlock',
  })
  @ApiOkResponse({ type: StorefrontBlockDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @Param('identifier') identifier: string,
  ) {
    return found(await this.cms.block(ctx, identifier), 'Block');
  }
}
