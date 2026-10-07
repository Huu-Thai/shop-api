import { Module } from '@nestjs/common';
import { ShippingMethodsController } from './shipping.controller.js';
import { ShippingMethodsService } from './shipping-methods.service.js';
import { ShippingQuery } from './shipping.query.js';

/** Shipping methods and rates per website. */
@Module({
  controllers: [ShippingMethodsController],
  providers: [ShippingMethodsService, ShippingQuery],
  exports: [ShippingQuery],
})
export class ShippingModule {}
