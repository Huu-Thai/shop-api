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
  ApiAcceptedResponse,
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
  CreateExchangeRateDto,
  CreatePriceBookDto,
  ExchangeRateDto,
  ListPriceEntriesQueryDto,
  PriceBookDto,
  PriceEntryListDto,
  PricePreviewDto,
  PricePreviewQueryDto,
  ReindexDto,
  SetPriceEntriesDto,
  UpdatePriceBookDto,
} from './dto/pricing.dto.js';
import { PriceBooksService } from './price-books.service.js';
import { PriceIndexListener } from './price-index.listener.js';
import { PriceIndexer } from './price-indexer.js';

@ApiTags('admin · pricing')
@Controller('admin')
export class PricingController {
  constructor(
    private readonly books: PriceBooksService,
    private readonly indexer: PriceIndexer,
    private readonly queue: PriceIndexListener,
  ) {}

  @Get('price-books')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: [PriceBookDto] })
  list() {
    return this.books.list();
  }

  @Get('price-books/:id')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: PriceBookDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.books.get(id);
  }

  @Post('price-books')
  @RequirePermissions('pricing:write')
  @ApiCreatedResponse({ type: PriceBookDto })
  create(@Body() dto: CreatePriceBookDto, @CurrentPrincipal() p: Principal) {
    return this.books.create(dto, p);
  }

  @Patch('price-books/:id')
  @RequirePermissions('pricing:write')
  @ApiOkResponse({ type: PriceBookDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceBookDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.books.update(id, dto, p);
  }

  @Delete('price-books/:id')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.books.remove(id, p);
  }

  @Get('price-books/:id/entries')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: PriceEntryListDto })
  entries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListPriceEntriesQueryDto,
  ) {
    return this.books.entries(id, q);
  }

  @Put('price-books/:id/entries')
  @RequirePermissions('pricing:write')
  @ApiOperation({
    summary:
      'Upsert prices by (variant or SKU, min qty); the index updates in the background',
  })
  @ApiOkResponse({
    schema: { type: 'object', properties: { upserted: { type: 'integer' } } },
  })
  setEntries(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPriceEntriesDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.books.setEntries(id, dto, p);
  }

  @Delete('price-books/:id/entries/:entryId')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.books.removeEntry(id, entryId, p);
  }

  @Get('exchange-rates')
  @RequirePermissions('pricing:read')
  @ApiOkResponse({ type: [ExchangeRateDto] })
  rates() {
    return this.books.exchangeRates();
  }

  @Post('exchange-rates')
  @RequirePermissions('pricing:write')
  @ApiCreatedResponse({ type: ExchangeRateDto })
  addRate(
    @Body() dto: CreateExchangeRateDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.books.addExchangeRate(dto, p);
  }

  @Get('prices/preview')
  @RequirePermissions('pricing:read')
  @ApiOperation({
    summary:
      'Resolve a variant’s price live: matching books, tiers, tax for a quantity',
  })
  @ApiOkResponse({ type: PricePreviewDto })
  preview(@Query() q: PricePreviewQueryDto) {
    return this.indexer.preview(q);
  }

  @Post('prices/reindex')
  @RequirePermissions('pricing:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Rebuild the price index (some variants or everything) in the background',
  })
  @ApiAcceptedResponse()
  async reindex(@Body() dto: ReindexDto) {
    await this.queue.rebuild(dto.variantIds);
    return { queued: true };
  }
}
