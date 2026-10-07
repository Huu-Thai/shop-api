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
import { AdminUsersService } from './admin-users.service.js';
import {
  AdminUserDto,
  AdminUserPageDto,
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  ResetPasswordDto,
  UpdateAdminUserDto,
} from './dto/admin-user.dto.js';

@ApiTags('admin · users')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermissions('admin-users:read')
  @ApiOkResponse({ type: AdminUserPageDto })
  list(@Query() q: ListAdminUsersQueryDto) {
    return this.users.list(q);
  }

  @Get(':id')
  @RequirePermissions('admin-users:read')
  @ApiOkResponse({ type: AdminUserDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('admin-users:write')
  @ApiOperation({
    summary:
      'Create an admin user (you can only assign roles whose permissions you hold)',
  })
  @ApiCreatedResponse({ type: AdminUserDto })
  @ApiConflictResponse({ description: 'E-mail already in use' })
  create(@Body() dto: CreateAdminUserDto, @CurrentPrincipal() p: Principal) {
    return this.users.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('admin-users:write')
  @ApiOperation({
    summary:
      'Update profile, status or roles (disabling ends the user’s sessions)',
  })
  @ApiOkResponse({ type: AdminUserDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.users.update(id, dto, p);
  }

  @Post(':id/reset-password')
  @RequirePermissions('admin-users:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Set a new password for a user (ends their sessions, clears a lockout)',
  })
  @ApiNoContentResponse()
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.users.resetPassword(id, dto.newPassword, p);
  }

  @Delete(':id')
  @RequirePermissions('admin-users:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.users.remove(id, p);
  }
}
