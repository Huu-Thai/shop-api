import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  applyDecorators,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  Public,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { CART_TOKEN_HEADER } from '../carts/carts.service.js';
import { NoStoreInterceptor } from '../stores/context/storefront-cache.interceptor.js';
import {
  CustomerRequiredGuard,
  STORE_HEADER,
  StoreContextGuard,
} from '../stores/context/store-context.guard.js';
import {
  CurrentCustomer,
  type StoreContext,
  StoreCtx,
  type StorefrontCustomer,
} from '../stores/context/store-context.js';
import {
  AdminOrderDto,
  AdminOrderListDto,
  CancelOrderDto,
  CreateShipmentDto,
  ListOrdersQueryDto,
  OrderDto,
  OrderListDto,
  OrderNoteDto,
  ShipmentResultDto,
} from './dto/order.dto.js';
import { OrdersQuery } from './orders.query.js';
import { OrdersService } from './orders.service.js';

export const ORDER_TOKEN_HEADER = 'x-order-token';

const StorefrontOrders = () =>
  applyDecorators(
    Public(),
    UseGuards(StoreContextGuard),
    UseInterceptors(NoStoreInterceptor),
    ApiTags('storefront · orders'),
    ApiBearerAuth('customer'),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description: 'Store code',
    }),
  );

@StorefrontOrders()
@Controller('store/orders')
export class StorefrontOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly query: OrdersQuery,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Place the order from the cart (safe to retry with the same Idempotency-Key)',
    operationId: 'placeOrder',
  })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description: 'Unique per checkout attempt; a retry returns the same order',
  })
  @ApiHeader({
    name: CART_TOKEN_HEADER,
    required: false,
    description: 'Guest cart token',
  })
  @ApiOkResponse({ type: OrderDto })
  async place(
    @StoreCtx() ctx: StoreContext,
    @Headers('idempotency-key') key: string,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
  ) {
    const placed = await this.orders.place(ctx, cartToken, key ?? '');
    return {
      ...(await this.query.publicView(placed.orderId)),
      ...(ctx.customer ? {} : { accessToken: placed.accessToken }),
    };
  }

  @Get()
  @UseGuards(CustomerRequiredGuard)
  @ApiOperation({
    summary: 'My orders in this store',
    operationId: 'listOrders',
  })
  @ApiOkResponse({ type: OrderListDto })
  list(
    @StoreCtx() ctx: StoreContext,
    @CurrentCustomer() c: StorefrontCustomer,
    @Query() q: ListOrdersQueryDto,
  ) {
    return this.query.forCustomer(ctx, c.id, q);
  }

  @Get(':number')
  @ApiOperation({
    summary: 'An order (its customer, or a guest with X-Order-Token)',
    operationId: 'getOrder',
  })
  @ApiHeader({ name: ORDER_TOKEN_HEADER, required: false })
  @ApiOkResponse({ type: OrderDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @Param('number') number: string,
    @Headers(ORDER_TOKEN_HEADER) token?: string,
  ) {
    return this.query.publicView(
      await this.query.accessible(ctx, number, token),
    );
  }

  @Post(':number/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an order that is still waiting for payment',
    operationId: 'cancelOrder',
  })
  @ApiHeader({ name: ORDER_TOKEN_HEADER, required: false })
  @ApiOkResponse({ type: OrderDto })
  async cancel(
    @StoreCtx() ctx: StoreContext,
    @Param('number') number: string,
    @Body() dto: CancelOrderDto,
    @Headers(ORDER_TOKEN_HEADER) token?: string,
  ) {
    const id = await this.query.accessible(ctx, number, token);
    const o = await this.query.view(id);
    if (o.status !== 'PENDING_PAYMENT')
      throw new ForbiddenException(
        'Only orders waiting for payment can be cancelled here; contact us',
      );
    await this.orders.cancel(
      id,
      ctx.customer
        ? { type: 'customer', id: ctx.customer.id, label: ctx.customer.email }
        : { type: 'system', id: null, label: `guest ${o.email}` },
      dto.reason
        ? `Cancelled by the shopper: ${dto.reason}`
        : 'Cancelled by the shopper',
    );
    return this.query.publicView(id);
  }
}

@ApiTags('admin · orders')
@Controller('admin')
export class OrdersAdminController {
  constructor(
    private readonly orders: OrdersService,
    private readonly query: OrdersQuery,
  ) {}

  @Get('orders')
  @RequirePermissions('orders:read')
  @ApiOkResponse({ type: AdminOrderListDto })
  list(@Query() q: ListOrdersQueryDto) {
    return this.query.list(q);
  }

  @Get('orders/:id')
  @RequirePermissions('orders:read')
  @ApiOkResponse({ type: AdminOrderDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.view(id, true);
  }

  @Post('orders/:id/cancel')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel an unpaid, unshipped order (stock, promotion uses and points are given back)',
  })
  @ApiOkResponse({ type: AdminOrderDto })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
    @CurrentPrincipal() p: Principal,
  ) {
    await this.orders.cancel(
      id,
      actorOf(p),
      dto.reason ?? 'Cancelled by staff',
    );
    return this.query.view(id, true);
  }

  @Post('orders/:id/shipments')
  @RequirePermissions('orders:write')
  @ApiOperation({
    summary: 'Ship lines (everything open when `items` is omitted)',
  })
  @ApiCreatedResponse({ type: ShipmentResultDto })
  async ship(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShipmentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return { number: await this.orders.ship(id, dto, actorOf(p)) };
  }

  @Post('shipments/:id/deliver')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    await this.orders.deliver(id, actorOf(p));
  }

  @Post('orders/:id/notes')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async note(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderNoteDto,
    @CurrentPrincipal() p: Principal,
  ) {
    await this.orders.addNote(
      id,
      dto.message,
      dto.isPublic ?? false,
      actorOf(p),
    );
  }
}
