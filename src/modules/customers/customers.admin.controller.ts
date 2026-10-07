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
  ApiTags,
} from '@nestjs/swagger';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { AddressesService } from './addresses.service.js';
import { CustomersService } from './customers.service.js';
import {
  AddressDto,
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/address.dto.js';
import {
  CreateCustomerDto,
  CustomerDetailDto,
  CustomerDto,
  CustomerListDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto.js';

@ApiTags('admin · customers')
@Controller('admin/customers')
export class CustomersAdminController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
  ) {}

  @Get()
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: CustomerListDto })
  list(@Query() q: ListCustomersQueryDto) {
    return this.customers.list(q);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: CustomerDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(id);
  }

  @Post()
  @RequirePermissions('customers:write')
  @ApiCreatedResponse({ type: CustomerDto })
  create(@Body() dto: CreateCustomerDto, @CurrentPrincipal() p: Principal) {
    return this.customers.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  @ApiOperation({ summary: 'Edit, regroup, disable or re-enable an account' })
  @ApiOkResponse({ type: CustomerDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.customers.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Erase the account, its addresses, sessions and points',
  })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.customers.remove(id, p);
  }

  @Post(':id/logout')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End every session of the customer' })
  @ApiNoContentResponse()
  logout(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.customers.logoutEverywhere(id, p);
  }

  @Get(':id/addresses')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: [AddressDto] })
  listAddresses(@Param('id', ParseUUIDPipe) id: string) {
    return this.addresses.list(id);
  }

  @Post(':id/addresses')
  @RequirePermissions('customers:write')
  @ApiCreatedResponse({ type: AddressDto })
  addAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAddressDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.addresses.create(id, dto, actorOf(p));
  }

  @Patch(':id/addresses/:addressId')
  @RequirePermissions('customers:write')
  @ApiOkResponse({ type: AddressDto })
  updateAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateAddressDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.addresses.update(id, addressId, dto, actorOf(p));
  }

  @Delete(':id/addresses/:addressId')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.addresses.remove(id, addressId, actorOf(p));
  }
}
