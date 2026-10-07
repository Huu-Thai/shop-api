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
import type { Principal } from '../../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../../common/decorators/auth.decorators.js';
import {
  CreateRoleDto,
  PermissionDto,
  RoleDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import { RolesService } from './roles.service.js';

@ApiTags('admin · roles')
@Controller('admin')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('roles:read')
  @ApiOperation({
    summary: 'The permission catalogue (grantable to roles and API keys)',
  })
  @ApiOkResponse({ type: [PermissionDto] })
  permissions() {
    return this.roles.permissions();
  }

  @Get('roles')
  @RequirePermissions('roles:read')
  @ApiOkResponse({ type: [RoleDto] })
  list() {
    return this.roles.list();
  }

  @Get('roles/:id')
  @RequirePermissions('roles:read')
  @ApiOkResponse({ type: RoleDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @Post('roles')
  @RequirePermissions('roles:write')
  @ApiCreatedResponse({ type: RoleDto })
  @ApiConflictResponse({ description: 'Code already in use' })
  create(@Body() dto: CreateRoleDto, @CurrentPrincipal() p: Principal) {
    return this.roles.create(dto, p);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles:write')
  @ApiOkResponse({ type: RoleDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.roles.update(id, dto, p);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Still assigned to users' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.roles.remove(id, p);
  }
}
