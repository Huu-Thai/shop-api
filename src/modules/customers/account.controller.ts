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
  Req,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthThrottle } from '../../common/auth/throttle.decorators.js';
import { ACK, AckDto } from '../../common/dto/ack.dto.js';
import {
  StorefrontAccount,
  StorefrontAuth,
} from '../stores/context/storefront.decorator.js';
import {
  CurrentCustomer,
  type StoreContext,
  StoreCtx,
  type StorefrontCustomer,
} from '../stores/context/store-context.js';
import { AddressesService } from './addresses.service.js';
import { CustomerAuthService } from './auth/customer-auth.service.js';
import { customerActor } from './customers.events.js';
import { CustomersService } from './customers.service.js';
import {
  CustomerChangePasswordDto,
  CustomerLoginDto,
  CustomerLogoutDto,
  CustomerRefreshDto,
  CustomerTokenPairDto,
  ProfileDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/account.dto.js';
import {
  AddressDto,
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/address.dto.js';

const meta = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

@StorefrontAuth()
@Controller('store/account')
export class AccountAuthController {
  constructor(private readonly auth: CustomerAuthService) {}

  @Post('register')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create an account on this store’s website and sign in',
    operationId: 'register',
  })
  @ApiOkResponse({ type: CustomerTokenPairDto })
  @ApiTooManyRequestsResponse()
  register(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ) {
    return this.auth.register(ctx, dto, meta(req));
  }

  @Post('login')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in (accounts lock after repeated failures)',
    operationId: 'login',
  })
  @ApiOkResponse({ type: CustomerTokenPairDto })
  @ApiUnauthorizedResponse({ description: 'Invalid e-mail or password' })
  @ApiTooManyRequestsResponse()
  login(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: CustomerLoginDto,
    @Req() req: Request,
  ) {
    return this.auth.login(ctx, dto.email, dto.password, meta(req));
  }

  @Post('refresh')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange a refresh token for a new pair (single use; replaying one ends the session)',
    operationId: 'refreshSession',
  })
  @ApiOkResponse({ type: CustomerTokenPairDto })
  refresh(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: CustomerRefreshDto,
    @Req() req: Request,
  ) {
    return this.auth.refresh(ctx, dto.refreshToken, meta(req));
  }
}

@StorefrontAccount()
@Controller('store/account')
export class AccountController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My profile', operationId: 'getProfile' })
  @ApiOkResponse({ type: ProfileDto })
  profile(@CurrentCustomer() c: StorefrontCustomer) {
    return this.customers.profile(c);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my profile', operationId: 'updateProfile' })
  @ApiOkResponse({ type: ProfileDto })
  update(
    @CurrentCustomer() c: StorefrontCustomer,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.customers.updateProfile(c, dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign out (this session or everywhere)',
    operationId: 'logout',
  })
  @ApiOkResponse({ type: AckDto })
  async logout(
    @CurrentCustomer() c: StorefrontCustomer,
    @Body() dto: CustomerLogoutDto,
  ) {
    await this.auth.logout(c, dto.everywhere ?? false);
    return ACK;
  }

  @Post('password')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change my password (ends every session; sign in again)',
    operationId: 'changePassword',
  })
  @ApiOkResponse({ type: AckDto })
  async changePassword(
    @CurrentCustomer() c: StorefrontCustomer,
    @Body() dto: CustomerChangePasswordDto,
  ) {
    await this.auth.changePassword(c, dto.currentPassword, dto.newPassword);
    return ACK;
  }

  @Get('addresses')
  @ApiOperation({ summary: 'My address book', operationId: 'listAddresses' })
  @ApiOkResponse({ type: [AddressDto] })
  listAddresses(@CurrentCustomer() c: StorefrontCustomer) {
    return this.addresses.list(c.id);
  }

  @Post('addresses')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add an address', operationId: 'addAddress' })
  @ApiOkResponse({ type: AddressDto })
  addAddress(
    @CurrentCustomer() c: StorefrontCustomer,
    @Body() dto: CreateAddressDto,
  ) {
    return this.addresses.create(c.id, dto, customerActor(c));
  }

  @Patch('addresses/:id')
  @ApiOperation({ summary: 'Edit an address', operationId: 'updateAddress' })
  @ApiOkResponse({ type: AddressDto })
  updateAddress(
    @CurrentCustomer() c: StorefrontCustomer,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(c.id, id, dto, customerActor(c));
  }

  @Delete('addresses/:id')
  @ApiOperation({ summary: 'Remove an address', operationId: 'removeAddress' })
  @ApiOkResponse({ type: AckDto })
  async removeAddress(
    @CurrentCustomer() c: StorefrontCustomer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.addresses.remove(c.id, id, customerActor(c));
    return ACK;
  }
}
