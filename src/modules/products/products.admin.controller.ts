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
  Put,
  Query,
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
import {
  CreateProductDto,
  SetBundleOptionsDto,
  SetRelationsDto,
  StoreOverrideInputDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './dto/product-input.dto.js';
import {
  ListProductsQueryDto,
  ProductDto,
  ProductListDto,
  SearchVariantsQueryDto,
  StoreOverrideDto,
  VariantDto,
  VariantSearchItemDto,
} from './dto/product-view.dto.js';
import { ProductsService } from './products.service.js';
import { VariantsService } from './variants.service.js';

@ApiTags('admin · products')
@Controller('admin/products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly variants: VariantsService,
  ) {}

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: ProductListDto })
  list(@Query() q: ListProductsQueryDto) {
    return this.products.list(q);
  }

  @Get(':id')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: ProductDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(id);
  }

  @Post()
  @RequirePermissions('catalog:write')
  @ApiOperation({
    summary:
      'Create a product of any type (variants and bundle options can be included)',
  })
  @ApiCreatedResponse({ type: ProductDto })
  @ApiConflictResponse({ description: 'SKU or URL key already used' })
  create(@Body() dto: CreateProductDto, @CurrentPrincipal() p: Principal) {
    return this.products.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: ProductDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.products.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft delete (removed from every storefront; restorable)',
  })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.products.remove(id, p);
  }

  @Post(':id/restore')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ProductDto })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.products.restore(id, p);
  }

  @Post(':id/variants')
  @RequirePermissions('catalog:write')
  @ApiOperation({ summary: 'Add a variant to a configurable product' })
  @ApiCreatedResponse({ type: VariantDto })
  createVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VariantInputDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.variants.create(id, dto, p);
  }

  @Patch(':id/variants/:variantId')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: VariantDto })
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.variants.update(id, variantId, dto, p);
  }

  @Delete(':id/variants/:variantId')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'The variant is sold inside a bundle' })
  removeVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.variants.remove(id, variantId, p);
  }

  @Put(':id/bundle-options')
  @RequirePermissions('catalog:write')
  @ApiOperation({
    summary: 'Replace the options and selections of a bundle product',
  })
  @ApiOkResponse({ type: ProductDto })
  setBundleOptions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBundleOptionsDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.variants.setBundleOptions(id, dto, p);
  }

  @Put(':id/stores/:storeId')
  @RequirePermissions('catalog:write')
  @ApiOperation({
    summary:
      'Set the per-store override (status, visibility, attribute patch); an empty override is removed',
  })
  @ApiOkResponse({
    type: StoreOverrideDto,
    description: 'null when nothing is overridden any more',
  })
  setOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: StoreOverrideInputDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.products.setStoreOverride(id, storeId, dto, p);
  }

  @Delete(':id/stores/:storeId')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async removeOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    await this.products.setStoreOverride(
      id,
      storeId,
      { status: null, visibility: null, attributes: {} },
      p,
    );
  }

  @Put(':id/relations')
  @RequirePermissions('catalog:write')
  @ApiOperation({ summary: 'Replace related, up-sell and cross-sell products' })
  @ApiOkResponse({ type: ProductDto })
  setRelations(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRelationsDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.products.setRelations(id, dto, p);
  }
}

@ApiTags('admin · products')
@Controller('admin/variants')
export class VariantsAdminController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOperation({
    summary: 'Search variants by SKU, product SKU or product name (pickers)',
  })
  @ApiOkResponse({ type: [VariantSearchItemDto] })
  search(@Query() q: SearchVariantsQueryDto) {
    return this.products.searchVariants(q);
  }
}
