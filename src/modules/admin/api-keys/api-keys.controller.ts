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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../../common/auth/principal.js';
import {
  AdminOnly,
  CurrentPrincipal,
  RequirePermissions,
} from '../../../common/decorators/auth.decorators.js';
import { ApiKeysService } from './api-keys.service.js';
import {
  ApiKeyCreatedDto,
  ApiKeyDto,
  CreateApiKeyDto,
} from './dto/api-key.dto.js';

@ApiTags('admin · api keys')
@Controller('admin/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions('api-keys:read')
  @ApiQuery({ name: 'includeRevoked', required: false, type: Boolean })
  @ApiOkResponse({ type: [ApiKeyDto] })
  list(@Query('includeRevoked') includeRevoked?: string) {
    return this.keys.list(includeRevoked === 'true');
  }

  @Post()
  @RequirePermissions('api-keys:write')
  @AdminOnly()
  @ApiOperation({
    summary: 'Create an API key — the full key is returned once',
    description: 'Permissions must be a subset of your own.',
  })
  @ApiCreatedResponse({ type: ApiKeyCreatedDto })
  create(@Body() dto: CreateApiKeyDto, @CurrentPrincipal() p: Principal) {
    return this.keys.create(dto, p);
  }

  @Delete(':id')
  @RequirePermissions('api-keys:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key (takes effect within 30 s)' })
  @ApiNoContentResponse()
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.keys.revoke(id, p);
  }
}
