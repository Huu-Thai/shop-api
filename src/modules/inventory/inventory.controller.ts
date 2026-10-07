import {
  Body,
  Controller,
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
  CreateInventorySourceDto,
  InventorySourceDto,
  ListMovementsQueryDto,
  ListStockQueryDto,
  MovementListDto,
  ReservationDto,
  ReserveDto,
  SalableDto,
  SalableQueryDto,
  SetWebsiteSourcesDto,
  StockAdjustmentDto,
  StockDto,
  StockListDto,
  UpdateInventorySourceDto,
  WebsiteSourceDto,
} from './dto/inventory.dto.js';
import { InventoryQuery } from './inventory.query.js';
import { InventoryService } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

@ApiTags('admin · inventory')
@Controller('admin')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly reservations: ReservationsService,
    private readonly query: InventoryQuery,
  ) {}

  @Get('inventory/sources')
  @RequirePermissions('inventory:read')
  @ApiOkResponse({ type: [InventorySourceDto] })
  sources() {
    return this.inventory.sources();
  }

  @Post('inventory/sources')
  @RequirePermissions('inventory:write')
  @ApiCreatedResponse({ type: InventorySourceDto })
  createSource(
    @Body() dto: CreateInventorySourceDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.inventory.createSource(dto, p);
  }

  @Patch('inventory/sources/:id')
  @RequirePermissions('inventory:write')
  @ApiOkResponse({ type: InventorySourceDto })
  updateSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventorySourceDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.inventory.updateSource(id, dto, p);
  }

  @Get('websites/:id/inventory-sources')
  @RequirePermissions('inventory:read')
  @ApiOkResponse({ type: [WebsiteSourceDto] })
  websiteSources(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.websiteSources(id);
  }

  @Put('websites/:id/inventory-sources')
  @RequirePermissions('inventory:write')
  @ApiOperation({
    summary: 'Sources that sell into the website, in fulfilment order',
  })
  @ApiOkResponse({ type: [WebsiteSourceDto] })
  setWebsiteSources(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetWebsiteSourcesDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.inventory.setWebsiteSources(id, dto, p);
  }

  @Get('inventory/stock')
  @RequirePermissions('inventory:read')
  @ApiOkResponse({ type: StockListDto })
  stock(@Query() q: ListStockQueryDto) {
    return this.inventory.stock(q);
  }

  @Post('inventory/adjustments')
  @RequirePermissions('inventory:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Receive, write off or recount stock of a variant at a source (recorded in the ledger)',
  })
  @ApiOkResponse({ type: StockDto })
  @ApiConflictResponse({
    description:
      'Below the reserved quantity, or the row changed (expectedVersion)',
  })
  adjust(@Body() dto: StockAdjustmentDto, @CurrentPrincipal() p: Principal) {
    return this.inventory.adjust(dto, p);
  }

  @Get('inventory/movements')
  @RequirePermissions('inventory:read')
  @ApiOkResponse({ type: MovementListDto })
  movements(@Query() q: ListMovementsQueryDto) {
    return this.inventory.movements(q);
  }

  @Get('inventory/salable')
  @RequirePermissions('inventory:read')
  @ApiQuery({
    name: 'variantIds',
    type: String,
    description: 'Comma-separated',
  })
  @ApiOkResponse({ type: [SalableDto] })
  async salable(@Query() q: SalableQueryDto): Promise<SalableDto[]> {
    const m = await this.query.salable(q.websiteId, q.variantIds);
    return [...m.entries()].map(([variantId, s]) => ({ variantId, ...s }));
  }

  @Post('inventory/reservations')
  @RequirePermissions('inventory:write')
  @ApiOperation({
    summary:
      'Hold stock for a cart or order (released automatically after ttlSeconds)',
  })
  @ApiCreatedResponse({ type: ReservationDto })
  @ApiConflictResponse({ description: 'Not enough salable stock' })
  reserve(@Body() dto: ReserveDto, @CurrentPrincipal() p: Principal) {
    return this.reservations.reserve(dto, p);
  }

  @Get('inventory/reservations/:groupId')
  @RequirePermissions('inventory:read')
  @ApiOkResponse({ type: ReservationDto })
  getReservation(@Param('groupId', ParseUUIDPipe) groupId: string) {
    return this.reservations.get(groupId);
  }

  @Post('inventory/reservations/:groupId/release')
  @RequirePermissions('inventory:write')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ReservationDto })
  release(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.reservations.release(groupId, p);
  }

  @Post('inventory/reservations/:groupId/convert')
  @RequirePermissions('inventory:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The reserved units were sold: deduct them from stock',
  })
  @ApiOkResponse({ type: ReservationDto })
  convert(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.reservations.convert(groupId, undefined, p);
  }
}
