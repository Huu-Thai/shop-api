import { Global, Module } from '@nestjs/common';
import { TaxCacheListener } from './tax-cache.listener.js';
import { TaxClassUsageListener } from './tax-class.listener.js';
import { TaxController } from './tax.controller.js';
import { TaxQuery } from './tax.query.js';
import { TaxService } from './tax.service.js';

/** Multi-country tax: classes, zones, effective-dated rates and the calculator (PLAN.md §9.7). */
@Global()
@Module({
  controllers: [TaxController],
  providers: [TaxService, TaxQuery, TaxCacheListener, TaxClassUsageListener],
  exports: [TaxQuery],
})
export class TaxModule {}
