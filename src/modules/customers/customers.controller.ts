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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import {
  CreateCustomerGroupDto,
  CustomerGroupDto,
  UpdateCustomerGroupDto,
} from './dto/customer-group.dto.js';

@ApiTags('admin · customer groups')
@Controller('admin/customer-groups')
export class CustomerGroupsController {
  constructor(private readonly groups: CustomerGroupsService) {}

  @Get()
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: [CustomerGroupDto] })
  list() {
    return this.groups.list();
  }

  @Post()
  @RequirePermissions('customers:write')
  @ApiCreatedResponse({ type: CustomerGroupDto })
  create(
    @Body() dto: CreateCustomerGroupDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.groups.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  @ApiOkResponse({ type: CustomerGroupDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerGroupDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.groups.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.groups.remove(id, p);
  }
}
