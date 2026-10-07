import { Module } from '@nestjs/common';
import { CartsModule } from '../carts/carts.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentConfigService } from './payment-config.service.js';
import {
  CartPaymentMethodsController,
  PaymentsAdminController,
  PaymentWebhooksController,
  StorefrontPaymentsController,
} from './payments.controllers.js';
import { PaymentsListener } from './payments.listener.js';
import { PaymentsService } from './payments.service.js';
import { PaymentAdapters } from './providers/registry.js';
import { RefundsService } from './refunds.service.js';

/** Payments (PLAN.md §9.6): providers, store methods, payments, webhooks, refunds, reconciliation. */
@Module({
  imports: [OrdersModule, CartsModule],
  controllers: [
    StorefrontPaymentsController,
    CartPaymentMethodsController,
    PaymentWebhooksController,
    PaymentsAdminController,
  ],
  providers: [
    PaymentAdapters,
    PaymentConfigService,
    PaymentsService,
    RefundsService,
    PaymentsListener,
  ],
  exports: [
    PaymentsService,
    RefundsService,
    PaymentAdapters,
    CartsModule,
    OrdersModule,
  ],
})
export class PaymentsModule {}
