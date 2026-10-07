import { ExportCustomersJob } from './customers.jobs.js';
import { Global, Module } from '@nestjs/common';
import { CUSTOMER_TOKEN_RESOLVER } from '../stores/context/store-context.js';
import {
  AccountAuthController,
  AccountController,
} from './account.controller.js';
import { AddressesService } from './addresses.service.js';
import { CustomerAuthService } from './auth/customer-auth.service.js';
import { CustomerSessionService } from './auth/customer-session.service.js';
import { CustomerTokenResolverService } from './auth/customer-token.resolver.js';
import { CustomerGroupsService } from './customer-groups.service.js';
import { CustomersAdminController } from './customers.admin.controller.js';
import { CustomerGroupsController } from './customers.controller.js';
import { CustomersQuery } from './customers.query.js';
import { CustomersService } from './customers.service.js';

/**
 * Customers (PLAN.md §3.2): groups (prices, tax class), accounts per website with addresses and
 * storefront sessions. Global so the store scope can resolve customer tokens.
 */
@Global()
@Module({
  controllers: [
    CustomerGroupsController,
    CustomersAdminController,
    AccountAuthController,
    AccountController,
  ],
  providers: [
    CustomerGroupsService,
    CustomersQuery,
    CustomersService,
    AddressesService,
    CustomerSessionService,
    CustomerAuthService,
    CustomerTokenResolverService,
    ExportCustomersJob,
    {
      provide: CUSTOMER_TOKEN_RESOLVER,
      useExisting: CustomerTokenResolverService,
    },
  ],
  exports: [CustomersQuery, CUSTOMER_TOKEN_RESOLVER],
})
export class CustomersModule {}
