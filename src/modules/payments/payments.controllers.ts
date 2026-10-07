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
  Query,
  type RawBodyRequest,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  Public,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { paginated } from '../../common/dto/pagination.dto.js';
import { CART_TOKEN_HEADER, CartsService } from '../carts/carts.service.js';
import { ORDER_TOKEN_HEADER } from '../orders/orders.controllers.js';
import { OrdersQuery } from '../orders/orders.query.js';
import { NoStoreInterceptor } from '../stores/context/storefront-cache.interceptor.js';
import {
  STORE_HEADER,
  StoreContextGuard,
} from '../stores/context/store-context.guard.js';
import {
  type StoreContext,
  StoreCtx,
} from '../stores/context/store-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  CreateProviderDto,
  CreateRefundDto,
  CreateStoreMethodDto,
  ListWebhooksQueryDto,
  OrderPaymentsDto,
  PaymentDto,
  PaymentMethodDto,
  PaymentReturnDto,
  PayOrderDto,
  ProviderDto,
  ReconcileResultDto,
  RefundDto,
  StoreMethodDto,
  UpdateProviderDto,
  UpdateStoreMethodDto,
  WebhookEventListDto,
  AdminPaymentDto,
} from './dto/payments.dto.js';
import { PaymentConfigService } from './payment-config.service.js';
import { PaymentsService } from './payments.service.js';
import { RefundsService } from './refunds.service.js';

const StorefrontPayments = () =>
  applyDecorators(
    Public(),
    UseGuards(StoreContextGuard),
    UseInterceptors(NoStoreInterceptor),
    ApiTags('storefront · payments'),
    ApiBearerAuth('customer'),
    ApiHeader({
      name: STORE_HEADER,
      required: false,
      description: 'Store code',
    }),
  );

/** Guests send the order token; customers use their session (declared per route so it stays optional). */
const OrderToken = () =>
  ApiHeader({
    name: ORDER_TOKEN_HEADER,
    required: false,
    description: 'Guest order token',
  });

const clientIp = (req: Request) =>
  (req.ip ?? '127.0.0.1').replace(/^::ffff:/, '');

@StorefrontPayments()
@Controller('store/orders/:number')
export class StorefrontPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly orders: OrdersQuery,
  ) {}

  @Get('payment-methods')
  @ApiOperation({
    summary: 'How this order can be paid',
    operationId: 'listOrderPaymentMethods',
  })
  @OrderToken()
  @ApiOkResponse({ type: [PaymentMethodDto] })
  async methods(
    @StoreCtx() ctx: StoreContext,
    @Param('number') number: string,
    @Headers(ORDER_TOKEN_HEADER) token?: string,
  ) {
    return this.payments.methodsForOrder(
      await this.orders.accessible(ctx, number, token),
    );
  }

  @Post('payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pay the order: returns what to do next (redirect, Stripe client secret, or nothing for cash on delivery)',
    operationId: 'payOrder',
  })
  @OrderToken()
  @ApiOkResponse({ type: PaymentDto })
  async pay(
    @StoreCtx() ctx: StoreContext,
    @Param('number') number: string,
    @Body() dto: PayOrderDto,
    @Req() req: Request,
    @Headers(ORDER_TOKEN_HEADER) token?: string,
  ) {
    return this.payments.pay(
      await this.orders.accessible(ctx, number, token),
      dto,
      clientIp(req),
    );
  }

  @Post('payments/:paymentId/return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'The shopper is back from the provider: send the parameters it added to the return URL',
    operationId: 'completePayment',
  })
  @OrderToken()
  @ApiOkResponse({ type: PaymentDto })
  async complete(
    @StoreCtx() ctx: StoreContext,
    @Param('number') number: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: PaymentReturnDto,
    @Headers(ORDER_TOKEN_HEADER) token?: string,
  ) {
    return this.payments.handleReturn(
      await this.orders.accessible(ctx, number, token),
      paymentId,
      dto.params,
    );
  }
}

@StorefrontPayments()
@Controller('store/cart')
export class CartPaymentMethodsController {
  constructor(
    private readonly carts: CartsService,
    private readonly config: PaymentConfigService,
  ) {}

  @Get('payment-methods')
  @ApiOperation({
    summary: 'Payment methods the cart can use (for the checkout page)',
    operationId: 'listCartPaymentMethods',
  })
  @ApiHeader({ name: CART_TOKEN_HEADER, required: false })
  @ApiOkResponse({ type: [PaymentMethodDto] })
  async methods(
    @StoreCtx() ctx: StoreContext,
    @Headers(CART_TOKEN_HEADER) token?: string,
  ) {
    const p = await this.carts.price(await this.carts.require(ctx, token), ctx);
    const billing = (p.cart.billingAddress ?? p.cart.shippingAddress) as {
      countryCode?: string;
    } | null;
    const rows = await this.config.eligibleMethods({
      storeId: ctx.storeId,
      currencyCode: p.cart.currencyCode,
      countryCode: billing?.countryCode ?? null,
      amount: p.amountDue,
      localeChain: ctx.localeChain,
    });
    return rows.map(({ id: _i, providerId: _p, ...m }) => m);
  }
}

/** Provider notifications: public, verified by signature, answered in each provider's format. */
@ApiTags('webhooks')
@Public()
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  private async handle(
    providerId: string,
    req: RawBodyRequest<Request>,
    res: Response,
  ) {
    const ack = await this.payments.webhook(providerId, {
      headers: req.headers,
      rawBody: req.rawBody ?? Buffer.from(''),
      query: Object.fromEntries(
        Object.entries(req.query).map(([k, v]) => [k, String(v)]),
      ),
    });
    res.status(ack.status);
    if (ack.body === undefined) res.end();
    else res.json(ack.body);
  }

  @Post(':providerId')
  @ApiOperation({ summary: 'Payment notification (Stripe, PayPal, MoMo IPN)' })
  async post(
    @Param('providerId', ParseUUIDPipe) id: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    await this.handle(id, req, res);
  }

  @Get(':providerId')
  @ApiOperation({
    summary: 'Payment notification sent as a query string (VNPay IPN)',
  })
  async get(
    @Param('providerId', ParseUUIDPipe) id: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ) {
    await this.handle(id, req, res);
  }
}

@ApiTags('admin · payments')
@Controller('admin')
export class PaymentsAdminController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly config: PaymentConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('payment-providers')
  @RequirePermissions('orders:read')
  @ApiOkResponse({ type: [ProviderDto] })
  providers() {
    return this.config.providers();
  }

  @Post('payment-providers')
  @RequirePermissions('settings:write')
  @ApiCreatedResponse({ type: ProviderDto })
  createProvider(
    @Body() dto: CreateProviderDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.createProvider(dto, p);
  }

  @Patch('payment-providers/:id')
  @RequirePermissions('settings:write')
  @ApiOkResponse({ type: ProviderDto })
  updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProviderDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.updateProvider(id, dto, p);
  }

  @Delete('payment-providers/:id')
  @RequirePermissions('settings:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.removeProvider(id, p);
  }

  @Get('payment-methods')
  @RequirePermissions('orders:read')
  @ApiQuery({ name: 'storeId', required: false })
  @ApiOkResponse({ type: [StoreMethodDto] })
  methods(@Query('storeId') storeId?: string) {
    return this.config.methods(storeId || undefined);
  }

  @Post('payment-methods')
  @RequirePermissions('settings:write')
  @ApiCreatedResponse({ type: StoreMethodDto })
  createMethod(
    @Body() dto: CreateStoreMethodDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.createMethod(dto, p);
  }

  @Patch('payment-methods/:id')
  @RequirePermissions('settings:write')
  @ApiOkResponse({ type: StoreMethodDto })
  updateMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreMethodDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.updateMethod(id, dto, p);
  }

  @Delete('payment-methods/:id')
  @RequirePermissions('settings:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.config.removeMethod(id, p);
  }

  @Get('orders/:id/payments')
  @RequirePermissions('orders:read')
  @ApiOkResponse({ type: OrderPaymentsDto })
  forOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.forOrder(id);
  }

  @Post('payments/:id/capture')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cash on delivery collected' })
  @ApiOkResponse({ type: AdminPaymentDto })
  capture(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.payments.captureCod(id, actorOf(p));
  }

  @Post('orders/:id/refunds')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Refund (all or part, optionally returned lines with restocking); safe to retry with an Idempotency-Key',
  })
  @ApiHeader({ name: 'idempotency-key', required: false })
  @ApiOkResponse({ type: RefundDto })
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRefundDto,
    @CurrentPrincipal() p: Principal,
    @Headers('idempotency-key') key?: string,
  ) {
    const r = await this.refunds.refund(id, dto, key || undefined, actorOf(p));
    const all = await this.payments.forOrder(id);
    return all.refunds.find((x) => x.id === r.id)!;
  }

  @Post('payments/reconcile')
  @RequirePermissions('orders:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask providers about pending payments and refunds now (the job does it every 10 minutes)',
  })
  @ApiOkResponse({ type: ReconcileResultDto })
  reconcile() {
    return this.payments.reconcile(new Date(), 0);
  }

  @Get('payment-webhooks')
  @RequirePermissions('orders:read')
  @ApiOkResponse({ type: WebhookEventListDto })
  async webhooks(@Query() q: ListWebhooksQueryDto) {
    const where = { status: q.status, providerId: q.providerId };
    const [rows, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({
        where,
        select: {
          id: true,
          providerId: true,
          providerEventId: true,
          eventType: true,
          status: true,
          error: true,
          receivedAt: true,
        },
        orderBy: [{ receivedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return paginated(rows, total, q);
  }
}
