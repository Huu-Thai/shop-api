import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  CreateCurrencyDto,
  CreateLocaleDto,
  CurrencyDto,
  LocaleDto,
  UpdateCurrencyDto,
  UpdateLocaleDto,
} from './dto/locale-currency.dto.js';
import {
  CreateStoreDto,
  CreateWebsiteDto,
  StoreDto,
  UpdateStoreDto,
  UpdateWebsiteDto,
  WebsiteDto,
} from './dto/website-store.dto.js';
import { ReferenceDataService } from './reference-data.service.js';
import { StoresService } from './stores.service.js';
import { WebsitesService } from './websites.service.js';

@ApiTags('admin · locales & currencies')
@Controller('admin')
export class ReferenceDataController {
  constructor(private readonly ref: ReferenceDataService) {}

  @Get('locales')
  @RequirePermissions('stores:read')
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiOkResponse({ type: [LocaleDto] })
  locales(
    @Query('active', new ParseBoolPipe({ optional: true })) active?: boolean,
  ) {
    return this.ref.locales(active);
  }

  @Post('locales')
  @RequirePermissions('stores:write')
  @ApiCreatedResponse({ type: LocaleDto })
  createLocale(@Body() dto: CreateLocaleDto, @CurrentPrincipal() p: Principal) {
    return this.ref.createLocale(dto, p);
  }

  @Patch('locales/:code')
  @RequirePermissions('stores:write')
  @ApiParam({ name: 'code', example: 'vi-VN' })
  @ApiOkResponse({ type: LocaleDto })
  updateLocale(
    @Param('code') code: string,
    @Body() dto: UpdateLocaleDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ref.updateLocale(code, dto, p);
  }

  @Get('currencies')
  @RequirePermissions('stores:read')
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiOkResponse({ type: [CurrencyDto] })
  currencies(
    @Query('active', new ParseBoolPipe({ optional: true })) active?: boolean,
  ) {
    return this.ref.currencies(active);
  }

  @Post('currencies')
  @RequirePermissions('stores:write')
  @ApiCreatedResponse({ type: CurrencyDto })
  createCurrency(
    @Body() dto: CreateCurrencyDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ref.createCurrency(dto, p);
  }

  @Patch('currencies/:code')
  @RequirePermissions('stores:write')
  @ApiParam({ name: 'code', example: 'VND' })
  @ApiOkResponse({ type: CurrencyDto })
  updateCurrency(
    @Param('code') code: string,
    @Body() dto: UpdateCurrencyDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ref.updateCurrency(code.toUpperCase(), dto, p);
  }
}

@ApiTags('admin · websites & stores')
@Controller('admin')
export class WebsitesStoresController {
  constructor(
    private readonly websites: WebsitesService,
    private readonly stores: StoresService,
  ) {}

  @Get('websites')
  @RequirePermissions('stores:read')
  @ApiOkResponse({ type: [WebsiteDto] })
  listWebsites() {
    return this.websites.list();
  }

  @Get('websites/:id')
  @RequirePermissions('stores:read')
  @ApiOkResponse({ type: WebsiteDto })
  getWebsite(@Param('id', ParseUUIDPipe) id: string) {
    return this.websites.get(id);
  }

  @Post('websites')
  @RequirePermissions('stores:write')
  @ApiCreatedResponse({ type: WebsiteDto })
  createWebsite(
    @Body() dto: CreateWebsiteDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.websites.create(dto, p);
  }

  @Patch('websites/:id')
  @RequirePermissions('stores:write')
  @ApiOkResponse({ type: WebsiteDto })
  updateWebsite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebsiteDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.websites.update(id, dto, p);
  }

  @Delete('websites/:id')
  @RequirePermissions('stores:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Deleted; fails with 400 while the website still has stores',
  })
  removeWebsite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.websites.remove(id, p);
  }

  @Get('stores')
  @RequirePermissions('stores:read')
  @ApiQuery({ name: 'websiteId', required: false })
  @ApiOkResponse({ type: [StoreDto] })
  listStores(
    @Query('websiteId', new ParseUUIDPipe({ optional: true }))
    websiteId?: string,
  ) {
    return this.stores.list(websiteId);
  }

  @Get('stores/:id')
  @RequirePermissions('stores:read')
  @ApiOkResponse({ type: StoreDto })
  getStore(@Param('id', ParseUUIDPipe) id: string) {
    return this.stores.get(id);
  }

  @Post('stores')
  @RequirePermissions('stores:write')
  @ApiCreatedResponse({ type: StoreDto })
  createStore(@Body() dto: CreateStoreDto, @CurrentPrincipal() p: Principal) {
    return this.stores.create(dto, p);
  }

  @Patch('stores/:id')
  @RequirePermissions('stores:write')
  @ApiOkResponse({ type: StoreDto })
  updateStore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.stores.update(id, dto, p);
  }

  @Delete('stores/:id')
  @RequirePermissions('stores:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Deletes the store with its overrides and URL rewrites',
  })
  removeStore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.stores.remove(id, p);
  }
}
