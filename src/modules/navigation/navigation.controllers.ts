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
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  CacheTag,
  Storefront,
} from '../stores/context/storefront.decorator.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import {
  CreateMenuDto,
  CreateMenuItemDto,
  MenuDetailDto,
  MenuDto,
  MenuItemDto,
  StorefrontMenuDto,
  UpdateMenuDto,
  UpdateMenuItemDto,
} from './dto/menu.dto.js';
import { MenusQuery } from './menus.query.js';
import { MenusService } from './menus.service.js';

@ApiTags('admin · navigation')
@Controller('admin/navigation')
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @Get('menus')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: [MenuDto] })
  list() {
    return this.menus.list();
  }

  @Get('menus/:id')
  @RequirePermissions('cms:read')
  @ApiOkResponse({ type: MenuDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.menus.get(id);
  }

  @Post('menus')
  @RequirePermissions('cms:write')
  @ApiCreatedResponse({ type: MenuDto })
  create(@Body() dto: CreateMenuDto, @CurrentPrincipal() p: Principal) {
    return this.menus.create(dto, p);
  }

  @Patch('menus/:id')
  @RequirePermissions('cms:write')
  @ApiOkResponse({ type: MenuDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.menus.update(id, dto, p);
  }

  @Delete('menus/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.menus.remove(id, p);
  }

  @Post('menus/:id/items')
  @RequirePermissions('cms:write')
  @ApiOperation({
    summary: 'Add a link (page, post, category, product or URL)',
  })
  @ApiCreatedResponse({ type: MenuItemDto })
  addItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMenuItemDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.menus.addItem(id, dto, p);
  }

  @Patch('menu-items/:id')
  @RequirePermissions('cms:write')
  @ApiOperation({ summary: 'Edit, move or reorder an item' })
  @ApiOkResponse({ type: MenuItemDto })
  updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.menus.updateItem(id, dto, p);
  }

  @Delete('menu-items/:id')
  @RequirePermissions('cms:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'The item and its sub-items' })
  removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.menus.removeItem(id, p);
  }
}

@Storefront('navigation')
@CacheTag('menu')
@Controller('store/menus')
export class StorefrontMenusController {
  constructor(private readonly menus: MenusQuery) {}

  @Get(':code')
  @ApiOperation({
    summary: 'A menu as a tree of resolved links (the store’s own wins)',
    operationId: 'getMenu',
  })
  @ApiOkResponse({ type: StorefrontMenuDto })
  async get(@StoreCtx() ctx: StoreContext, @Param('code') code: string) {
    const m = await this.menus.menu(ctx, code);
    if (!m) throw new NotFoundException(`Menu ${code} not found`);
    return m;
  }
}
