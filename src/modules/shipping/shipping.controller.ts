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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  CreateShippingMethodDto,
  ShippingMethodDto,
  UpdateShippingMethodDto,
} from './dto/shipping.dto.js';
import { ShippingMethodsService } from './shipping-methods.service.js';

@ApiTags('admin · shipping')
@Controller('admin/shipping-methods')
export class ShippingMethodsController {
  constructor(private readonly methods: ShippingMethodsService) {}

  @Get()
  @RequirePermissions('orders:read')
  @ApiQuery({ name: 'websiteId', required: false })
  @ApiOkResponse({ type: [ShippingMethodDto] })
  list(@Query('websiteId') websiteId?: string) {
    return this.methods.list(websiteId || undefined);
  }

  @Post()
  @RequirePermissions('orders:write')
  @ApiCreatedResponse({ type: ShippingMethodDto })
  create(
    @Body() dto: CreateShippingMethodDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.methods.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('orders:write')
  @ApiOkResponse({ type: ShippingMethodDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShippingMethodDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.methods.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.methods.remove(id, p);
  }
}
