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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  CalculateTaxDto,
  CreateTaxClassDto,
  CreateTaxRateDto,
  CreateTaxZoneDto,
  TaxClassDto,
  TaxRateDto,
  TaxResultDto,
  TaxZoneDto,
  UpdateTaxClassDto,
  UpdateTaxRateDto,
  UpdateTaxZoneDto,
} from './dto/tax.dto.js';
import { TaxQuery } from './tax.query.js';
import { TaxService } from './tax.service.js';

@ApiTags('admin · tax')
@Controller('admin/tax')
export class TaxController {
  constructor(
    private readonly tax: TaxService,
    private readonly query: TaxQuery,
  ) {}

  @Get('classes')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: [TaxClassDto] })
  classes() {
    return this.tax.classes();
  }

  @Post('classes')
  @RequirePermissions('pricing:write')
  @ApiCreatedResponse({ type: TaxClassDto })
  createClass(
    @Body() dto: CreateTaxClassDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.createClass(dto, p);
  }

  @Patch('classes/:id')
  @RequirePermissions('pricing:write')
  @ApiOkResponse({ type: TaxClassDto })
  updateClass(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxClassDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.updateClass(id, dto, p);
  }

  @Delete('classes/:id')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeClass(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.removeClass(id, p);
  }

  @Get('zones')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: [TaxZoneDto] })
  zones() {
    return this.tax.zones();
  }

  @Post('zones')
  @RequirePermissions('pricing:write')
  @ApiCreatedResponse({ type: TaxZoneDto })
  createZone(@Body() dto: CreateTaxZoneDto, @CurrentPrincipal() p: Principal) {
    return this.tax.createZone(dto, p);
  }

  @Patch('zones/:id')
  @RequirePermissions('pricing:write')
  @ApiOkResponse({ type: TaxZoneDto })
  updateZone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxZoneDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.updateZone(id, dto, p);
  }

  @Delete('zones/:id')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeZone(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.removeZone(id, p);
  }

  @Get('rates')
  @RequirePermissions('pricing:read')
  @ApiQuery({ name: 'zoneId', required: false })
  @ApiOkResponse({ type: [TaxRateDto] })
  rates(
    @Query('zoneId', new ParseUUIDPipe({ optional: true })) zoneId?: string,
  ) {
    return this.tax.rates(zoneId);
  }

  @Post('rates')
  @RequirePermissions('pricing:write')
  @ApiCreatedResponse({ type: TaxRateDto })
  createRate(@Body() dto: CreateTaxRateDto, @CurrentPrincipal() p: Principal) {
    return this.tax.createRate(dto, p);
  }

  @Patch('rates/:id')
  @RequirePermissions('pricing:write')
  @ApiOperation({
    summary:
      'Rename, re-prioritise or end a rate (rates are effective-dated; add a new one to change the percentage)',
  })
  @ApiOkResponse({ type: TaxRateDto })
  updateRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxRateDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.updateRate(id, dto, p);
  }

  @Delete('rates/:id')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeRate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.tax.removeRate(id, p);
  }

  @Post('calculate')
  @RequirePermissions('pricing:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Calculate tax for lines and a destination (what checkout will use)',
  })
  @ApiOkResponse({ type: TaxResultDto })
  calculate(@Body() dto: CalculateTaxDto) {
    return this.query.calculateDto(dto);
  }
}
