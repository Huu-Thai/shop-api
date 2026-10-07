import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
  CreateRedirectDto,
  ListUrlRewritesQueryDto,
  RebuildUrlRewritesDto,
  UrlRewriteDto,
  UrlRewriteListDto,
} from './dto/url-rewrite.dto.js';
import { UrlRewritesService } from './url-rewrites.service.js';

@ApiTags('admin · url rewrites')
@Controller('admin/url-rewrites')
export class UrlRewritesController {
  constructor(private readonly rewrites: UrlRewritesService) {}

  @Get()
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: UrlRewriteListDto })
  list(@Query() q: ListUrlRewritesQueryDto) {
    return this.rewrites.list(q);
  }

  @Post()
  @RequirePermissions('catalog:write')
  @ApiOperation({ summary: 'Create a custom redirect' })
  @ApiCreatedResponse({ type: UrlRewriteDto })
  create(@Body() dto: CreateRedirectDto, @CurrentPrincipal() p: Principal) {
    return this.rewrites.createRedirect(dto, p);
  }

  @Delete(':id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Custom redirects only' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.rewrites.removeRedirect(id, p);
  }

  @Post('rebuild')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Rebuild the URL rewrites of one or every store in the background',
  })
  @ApiAcceptedResponse({
    schema: {
      type: 'object',
      properties: { storeIds: { type: 'array', items: { type: 'string' } } },
    },
  })
  async rebuild(@Body() dto: RebuildUrlRewritesDto) {
    return {
      storeIds: await this.rewrites.enqueueStoreRebuild(
        dto.storeId ? [dto.storeId] : undefined,
      ),
    };
  }
}
