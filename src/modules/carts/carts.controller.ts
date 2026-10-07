import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/auth.decorators.js';
import { NoStoreInterceptor } from '../stores/context/storefront-cache.interceptor.js';
import {
  STORE_HEADER,
  StoreContextGuard,
} from '../stores/context/store-context.guard.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import { cartView } from './cart-view.js';
import { CART_TOKEN_HEADER, CartsService } from './carts.service.js';
import { type CartRow } from './cart-pricer.js';
import {
  AddCartItemDto,
  CartDto,
  CartEmailDto,
  CouponCodeDto,
  LoyaltyPointsDto,
  MergeCartDto,
  SetAddressesDto,
  ShippingMethodChoiceDto,
  ShippingOptionDto,
  UpdateCartItemDto,
} from './dto/cart.dto.js';

/** Cart routes: store scope, an optional customer session or the guest cart token; never cached. */
const StorefrontCart = () =>
  applyDecorators(
    Public(),
    UseGuards(StoreContextGuard),
    UseInterceptors(NoStoreInterceptor),
    ApiTags('storefront · cart'),
    ApiBearerAuth('customer'),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description: 'Store code',
    }),
    ApiHeader({
      name: CART_TOKEN_HEADER,
      required: false,
      description:
        'Guest cart token (from POST /store/cart); signed-in customers use their session',
    }),
  );

@StorefrontCart()
@Controller('store/cart')
export class CartsController {
  constructor(private readonly carts: CartsService) {}

  private async view(
    ctx: StoreContext,
    cart: CartRow,
    token?: string,
  ): Promise<CartDto> {
    return cartView(await this.carts.price(cart, ctx), token);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Create a cart (guests receive its token once); a customer gets their current cart',
    operationId: 'createCart',
  })
  @ApiOkResponse({ type: CartDto })
  async create(@StoreCtx() ctx: StoreContext) {
    const { cart, token } = await this.carts.create(ctx);
    return this.view(ctx, cart, token);
  }

  @Get()
  @ApiOperation({
    summary: 'The cart with prices, promotions, shipping and tax',
    operationId: 'getCart',
  })
  @ApiOkResponse({ type: CartDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.require(ctx, token));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a product (a variant SKU; bundles with their choices)',
    operationId: 'addCartItem',
  })
  @ApiOkResponse({ type: CartDto })
  async add(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: AddCartItemDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.addItem(ctx, token, dto));
  }

  @Patch('items/:id')
  @ApiOperation({
    summary: 'Change a line’s quantity',
    operationId: 'updateCartItem',
  })
  @ApiOkResponse({ type: CartDto })
  async update(
    @StoreCtx() ctx: StoreContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCartItemDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(
      ctx,
      await this.carts.updateItem(ctx, token, id, dto.quantity),
    );
  }

  @Delete('items/:id')
  @ApiOperation({ summary: 'Remove a line', operationId: 'removeCartItem' })
  @ApiOkResponse({ type: CartDto })
  async remove(
    @StoreCtx() ctx: StoreContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.removeItem(ctx, token, id));
  }

  @Put('coupon')
  @ApiOperation({
    summary: 'Apply a coupon (400 with the reason when it doesn’t apply)',
    operationId: 'applyCoupon',
  })
  @ApiOkResponse({ type: CartDto })
  async coupon(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: CouponCodeDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.setCoupon(ctx, token, dto.code));
  }

  @Delete('coupon')
  @ApiOperation({ summary: 'Remove the coupon', operationId: 'removeCoupon' })
  @ApiOkResponse({ type: CartDto })
  async removeCoupon(
    @StoreCtx() ctx: StoreContext,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.setCoupon(ctx, token, null));
  }

  @Put('email')
  @ApiOperation({
    summary: 'Guest e-mail for the order',
    operationId: 'setCartEmail',
  })
  @ApiOkResponse({ type: CartDto })
  async email(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: CartEmailDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.setEmail(ctx, token, dto.email));
  }

  @Put('addresses')
  @ApiOperation({
    summary:
      'Shipping and billing addresses (fields, or an address book id when signed in)',
    operationId: 'setCartAddresses',
  })
  @ApiOkResponse({ type: CartDto })
  async addresses(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: SetAddressesDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(ctx, await this.carts.setAddresses(ctx, token, dto));
  }

  @Get('shipping-methods')
  @ApiOperation({
    summary: 'Shipping methods for the cart and its address, with prices',
    operationId: 'listShippingMethods',
  })
  @ApiOkResponse({ type: [ShippingOptionDto] })
  async shippingMethods(
    @StoreCtx() ctx: StoreContext,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    const p = await this.carts.price(await this.carts.require(ctx, token), ctx);
    const free = p.evaluation.result.freeShipping;
    return p.shippingOptions.map((o) => {
      const amount = free ? 0n : o.amount;
      return {
        code: o.code,
        carrier: o.carrier,
        name: o.name,
        description: o.description,
        price: { amount: Number(amount), formatted: p.format(amount) },
      };
    });
  }

  @Put('shipping-method')
  @ApiOperation({
    summary: 'Choose a shipping method',
    operationId: 'setShippingMethod',
  })
  @ApiOkResponse({ type: CartDto })
  async shippingMethod(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: ShippingMethodChoiceDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(
      ctx,
      await this.carts.setShippingMethod(ctx, token, dto.code),
    );
  }

  @Put('loyalty')
  @ApiOperation({
    summary: 'Pay part of the order with points (signed in; 0 removes them)',
    operationId: 'setCartPoints',
  })
  @ApiOkResponse({ type: CartDto })
  async loyalty(
    @StoreCtx() ctx: StoreContext,
    @Body() dto: LoyaltyPointsDto,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    return this.view(
      ctx,
      await this.carts.setLoyaltyPoints(ctx, token, dto.points),
    );
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'After signing in: move the guest cart into the customer’s cart',
    operationId: 'mergeCart',
  })
  @ApiOkResponse({ type: CartDto })
  async merge(@StoreCtx() ctx: StoreContext, @Body() dto: MergeCartDto) {
    return this.view(ctx, await this.carts.merge(ctx, dto.token));
  }
}
