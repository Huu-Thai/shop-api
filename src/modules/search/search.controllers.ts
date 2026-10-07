import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiAcceptedResponse,
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
  SearchStatusDto,
  UpdateSearchSettingsDto,
} from './dto/search-admin.dto.js';
import {
  SearchQueryDto,
  StorefrontSearchResultDto,
  StorefrontSuggestionDto,
  SuggestQueryDto,
} from './dto/search-storefront.dto.js';
import { SearchSettingsService } from './search-settings.service.js';
import { SearchService } from './search.service.js';

@Storefront('search')
@CacheTag('product')
@Controller('store/search')
export class StorefrontSearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary:
      'Search and faceted browsing (filters, price range, sort, disjunctive facet counts)',
    operationId: 'search',
  })
  @ApiOkResponse({ type: StorefrontSearchResultDto })
  query(
    @StoreCtx() ctx: StoreContext,
    @Query() q: SearchQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Which engine answered (debugging; e.g. POSTGRES-FALLBACK while an engine is down).
    return this.search.search(ctx, q, (kind) =>
      res.setHeader('X-Search-Engine', kind),
    );
  }

  @Get('suggest')
  @ApiOperation({
    summary: 'Search-as-you-type product suggestions',
    operationId: 'suggest',
  })
  @ApiOkResponse({ type: [StorefrontSuggestionDto] })
  suggest(@StoreCtx() ctx: StoreContext, @Query() q: SuggestQueryDto) {
    return this.search.suggest(ctx, q);
  }
}

@ApiTags('admin · search')
@Controller('admin/search/websites')
export class SearchAdminController {
  constructor(private readonly settings: SearchSettingsService) {}

  @Get(':websiteId')
  @RequirePermissions('catalog:read')
  @ApiOperation({
    summary: 'Search engine of a website, switch progress and document counts',
  })
  @ApiOkResponse({ type: SearchStatusDto })
  status(@Param('websiteId', ParseUUIDPipe) websiteId: string) {
    return this.settings.status(websiteId);
  }

  @Put(':websiteId')
  @RequirePermissions('settings:write')
  @ApiOperation({
    summary:
      'Choose the engine (Postgres, Elasticsearch, OpenSearch, Meilisearch); switching builds the new index in the background without downtime',
  })
  @ApiOkResponse({ type: SearchStatusDto })
  update(
    @Param('websiteId', ParseUUIDPipe) websiteId: string,
    @Body() dto: UpdateSearchSettingsDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.settings.update(websiteId, dto, p);
  }

  @Post(':websiteId/reindex')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse()
  async reindex(@Param('websiteId', ParseUUIDPipe) websiteId: string) {
    await this.settings.reindex(websiteId);
    return { queued: true };
  }
}
