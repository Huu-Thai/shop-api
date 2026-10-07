import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import { PublishContentDto } from '../../common/content/content.dto.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { BlocksService } from './blocks.service.js';
import {
  BlockDto,
  BlockListDto,
  CreateBlockDto,
  CreatePlacementDto,
  PlacementDto,
  UpdateBlockDto,
} from './dto/block.dto.js';
import {
  CreatePageDto,
  ListContentQueryDto,
  PageDto,
  PageListDto,
  UpdatePageDto,
} from './dto/page.dto.js';
import {
  CreatePostDto,
  ListPostsQueryDto,
  PostDto,
  PostListDto,
  UpdatePostDto,
} from './dto/post.dto.js';
import { CreateTagDto, TagDto, UpdateTagDto } from './dto/tag.dto.js';
import { PagesService } from './pages.service.js';
import { PostsService } from './posts.service.js';
import { TagsService } from './tags.service.js';

const PUBLISH_SUMMARY =
  'Publish now, or at `at` (the content goes live on time; the scheduler records it)';
const UNPUBLISH_SUMMARY =
  'Unpublish now, or at `at`; content that never went live returns to draft';

@ApiTags('admin · cms')
@Controller('admin/cms/pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: PageListDto })
  list(@Query() q: ListContentQueryDto) {
    return this.pages.list(q);
  }

  @Get(':id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: PageDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.pages.get(id);
  }

  @Post()
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Create a page (as a draft)' })
  @ApiCreatedResponse({ type: PageDto })
  create(@Body() dto: CreatePageDto, @CurrentPrincipal() p: Principal) {
    return this.pages.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: PageDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePageDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.pages.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.pages.remove(id, p);
  }

  @Post(':id/publish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH_SUMMARY })
  @ApiOkResponse({ type: PageDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.pages.publish(id, 'publish', dto.at, p);
  }

  @Post(':id/unpublish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH_SUMMARY })
  @ApiOkResponse({ type: PageDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.pages.publish(id, 'unpublish', dto.at, p);
  }
}

@ApiTags('admin · cms')
@Controller('admin/cms/posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: PostListDto })
  list(@Query() q: ListPostsQueryDto) {
    return this.posts.list(q);
  }

  @Get(':id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: PostDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.posts.get(id);
  }

  @Post()
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Create a blog post (as a draft)' })
  @ApiCreatedResponse({ type: PostDto })
  create(@Body() dto: CreatePostDto, @CurrentPrincipal() p: Principal) {
    return this.posts.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: PostDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.posts.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.posts.remove(id, p);
  }

  @Post(':id/publish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH_SUMMARY })
  @ApiOkResponse({ type: PostDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.posts.publish(id, 'publish', dto.at, p);
  }

  @Post(':id/unpublish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH_SUMMARY })
  @ApiOkResponse({ type: PostDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.posts.publish(id, 'unpublish', dto.at, p);
  }
}

@ApiTags('admin · cms')
@Controller('admin/cms/tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: [TagDto] })
  list() {
    return this.tags.list();
  }

  @Post()
  @RequirePermissions('cms:write')
  @ApiCreatedResponse({ type: TagDto })
  create(@Body() dto: CreateTagDto, @CurrentPrincipal() p: Principal) {
    return this.tags.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: TagDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTagDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tags.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tags.remove(id, p);
  }
}

@ApiTags('admin · cms')
@Controller('admin/cms')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get('blocks')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: BlockListDto })
  list(@Query() q: ListContentQueryDto) {
    return this.blocks.list(q);
  }

  @Get('blocks/:id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: BlockDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.get(id);
  }

  @Post('blocks')
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Create a block (as a draft)' })
  @ApiCreatedResponse({ type: BlockDto })
  create(@Body() dto: CreateBlockDto, @CurrentPrincipal() p: Principal) {
    return this.blocks.create(dto, p);
  }

  @Patch('blocks/:id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: BlockDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlockDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.update(id, dto, p);
  }

  @Delete('blocks/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.remove(id, p);
  }

  @Post('blocks/:id/publish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH_SUMMARY })
  @ApiOkResponse({ type: BlockDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.publish(id, 'publish', dto.at, p);
  }

  @Post('blocks/:id/unpublish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH_SUMMARY })
  @ApiOkResponse({ type: BlockDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.publish(id, 'unpublish', dto.at, p);
  }

  @Get('blocks/:id/placements')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: [PlacementDto] })
  placements(@Param('id', ParseUUIDPipe) id: string) {
    return this.blocks.placements(id);
  }

  @Post('blocks/:id/placements')
  @RequirePermissions('cms:write')
  @ApiOperation({
    summary: 'Place the block in a region of a page, post, category or product',
  })
  @ApiCreatedResponse({ type: PlacementDto })
  addPlacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePlacementDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.addPlacement(id, dto, p);
  }

  @Delete('block-placements/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removePlacement(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.blocks.removePlacement(id, p);
  }
}
