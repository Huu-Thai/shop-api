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
} from '@nestjs/common';
import {
  ApiConflictResponse,
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
import { AttributesService } from './attributes.service.js';
import { CategoriesService } from './categories.service.js';
import {
  AttributeDto,
  AttributeSetDto,
  CreateAttributeDto,
  CreateAttributeSetDto,
  UpdateAttributeDto,
  UpdateAttributeSetDto,
} from './dto/attribute.dto.js';
import {
  CategoryDto,
  CategoryNodeDto,
  CreateCategoryDto,
  MoveCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto.js';

@ApiTags('admin · attributes')
@Controller('admin')
export class AttributesController {
  constructor(private readonly attributes: AttributesService) {}

  @Get('attributes')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [AttributeDto] })
  list() {
    return this.attributes.list();
  }

  @Get('attributes/:id')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: AttributeDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.attributes.get(id);
  }

  @Post('attributes')
  @RequirePermissions('catalog:write')
  @ApiCreatedResponse({ type: AttributeDto })
  create(@Body() dto: CreateAttributeDto, @CurrentPrincipal() p: Principal) {
    return this.attributes.create(dto, p);
  }

  @Patch('attributes/:id')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: AttributeDto })
  @ApiConflictResponse({
    description: 'A removed option is still used by products',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttributeDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.attributes.update(id, dto, p);
  }

  @Delete('attributes/:id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Still used by products' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.attributes.remove(id, p);
  }

  @Get('attribute-sets')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [AttributeSetDto] })
  listSets() {
    return this.attributes.listSets();
  }

  @Get('attribute-sets/:id')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: AttributeSetDto })
  getSet(@Param('id', ParseUUIDPipe) id: string) {
    return this.attributes.getSet(id);
  }

  @Post('attribute-sets')
  @RequirePermissions('catalog:write')
  @ApiCreatedResponse({ type: AttributeSetDto })
  createSet(
    @Body() dto: CreateAttributeSetDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.attributes.createSet(dto, p);
  }

  @Patch('attribute-sets/:id')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: AttributeSetDto })
  updateSet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttributeSetDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.attributes.updateSet(id, dto, p);
  }

  @Delete('attribute-sets/:id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Fails with 400 while products use the set',
  })
  removeSet(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.attributes.removeSet(id, p);
  }
}

@ApiTags('admin · categories')
@Controller('admin/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [CategoryDto] })
  list() {
    return this.categories.list();
  }

  @Get('tree')
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'All categories as a nested tree' })
  @ApiOkResponse({ type: [CategoryNodeDto] })
  tree() {
    return this.categories.tree();
  }

  @Get(':id')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: CategoryDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(id);
  }

  @Post()
  @RequirePermissions('catalog:write')
  @ApiCreatedResponse({ type: CategoryDto })
  @ApiConflictResponse({
    description: 'A sibling or URL already uses the slug',
  })
  create(@Body() dto: CreateCategoryDto, @CurrentPrincipal() p: Principal) {
    return this.categories.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: CategoryDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.categories.update(id, dto, p);
  }

  @Post(':id/move')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Re-parent a category with its subtree (URLs are rebuilt, old ones redirect)',
  })
  @ApiOkResponse({ type: CategoryDto })
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveCategoryDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.categories.move(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'The category has subcategories' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.categories.remove(id, p);
  }
}
