import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { ListContentQueryDto } from '../cms/dto/page.dto.js';
import {
  CacheTag,
  Storefront,
} from '../stores/context/storefront.decorator.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import { BannersService } from './banners.service.js';
import {
  BannerDto,
  BannerListDto,
  CreateBannerDto,
  CreateSlideDto,
  CreateSliderDto,
  ListBannersQueryDto,
  SlideDto,
  SliderDto,
  SliderListDto,
  StorefrontBannerDto,
  StorefrontBannersQueryDto,
  StorefrontSliderDto,
  UpdateBannerDto,
  UpdateSlideDto,
  UpdateSliderDto,
} from './dto/merchandising.dto.js';
import { MerchandisingQuery } from './merchandising.query.js';
import { SlidersService } from './sliders.service.js';

const PUBLISH = 'Publish now, or at `at`';
const UNPUBLISH = 'Unpublish now, or at `at`';

@ApiTags('admin · merchandising')
@Controller('admin/merchandising/banners')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: BannerListDto })
  list(@Query() q: ListBannersQueryDto) {
    return this.banners.list(q);
  }

  @Get(':id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: BannerDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.banners.get(id);
  }

  @Post()
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Create a banner (as a draft)' })
  @ApiCreatedResponse({ type: BannerDto })
  create(@Body() dto: CreateBannerDto, @CurrentPrincipal() p: Principal) {
    return this.banners.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: BannerDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBannerDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.banners.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.banners.remove(id, p);
  }

  @Post(':id/publish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH })
  @ApiOkResponse({ type: BannerDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.banners.publish(id, 'publish', dto.at, p);
  }

  @Post(':id/unpublish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH })
  @ApiOkResponse({ type: BannerDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.banners.publish(id, 'unpublish', dto.at, p);
  }
}

@ApiTags('admin · merchandising')
@Controller('admin/merchandising')
export class SlidersController {
  constructor(private readonly sliders: SlidersService) {}

  @Get('sliders')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: SliderListDto })
  list(@Query() q: ListContentQueryDto) {
    return this.sliders.list(q);
  }

  @Get('sliders/:id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: SliderDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sliders.get(id);
  }

  @Post('sliders')
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Create a slider (as a draft)' })
  @ApiCreatedResponse({ type: SliderDto })
  create(@Body() dto: CreateSliderDto, @CurrentPrincipal() p: Principal) {
    return this.sliders.create(dto, p);
  }

  @Patch('sliders/:id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: SliderDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSliderDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.update(id, dto, p);
  }

  @Delete('sliders/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.remove(id, p);
  }

  @Post('sliders/:id/publish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH })
  @ApiOkResponse({ type: SliderDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.publish(id, 'publish', dto.at, p);
  }

  @Post('sliders/:id/unpublish')
  @RequirePermissions('cms:publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH })
  @ApiOkResponse({ type: SliderDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.publish(id, 'unpublish', dto.at, p);
  }

  @Post('sliders/:id/slides')
  @RequirePermissions('cms:write')
  @ApiCreatedResponse({ type: SlideDto })
  addSlide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSlideDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.addSlide(id, dto, p);
  }

  @Patch('slides/:id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: SlideDto })
  updateSlide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlideDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.updateSlide(id, dto, p);
  }

  @Delete('slides/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeSlide(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.sliders.removeSlide(id, p);
  }
}

@Storefront('merchandising')
@CacheTag('banner')
@Controller('store/banners')
export class StorefrontBannersController {
  constructor(private readonly merch: MerchandisingQuery) {}

  @Get()
  @ApiOperation({
    summary: 'Banners visible now in a placement, in order',
    operationId: 'listBanners',
  })
  @ApiOkResponse({ type: [StorefrontBannerDto] })
  list(@StoreCtx() ctx: StoreContext, @Query() q: StorefrontBannersQueryDto) {
    return this.merch.banners(ctx, q.placement);
  }
}

@Storefront('merchandising')
@CacheTag('slider')
@Controller('store/sliders')
export class StorefrontSlidersController {
  constructor(private readonly merch: MerchandisingQuery) {}

  @Get(':code')
  @ApiOperation({
    summary: 'A slider and its active slides (the store’s own wins)',
    operationId: 'getSlider',
  })
  @ApiOkResponse({ type: StorefrontSliderDto })
  async get(@StoreCtx() ctx: StoreContext, @Param('code') code: string) {
    const s = await this.merch.slider(ctx, code);
    if (!s) throw new NotFoundException(`Slider ${code} not found`);
    return s;
  }
}
