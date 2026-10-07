import { Module } from '@nestjs/common';
import {
  AccountLoyaltyController,
  LoyaltyAdminController,
} from './loyalty.controllers.js';
import { LoyaltyListener } from './loyalty.listener.js';
import { LoyaltyProgramsService } from './loyalty-programs.service.js';
import { LoyaltyQuery } from './loyalty.query.js';
import { LoyaltyService } from './loyalty.service.js';

/** Loyalty (PLAN.md §9.8): programs per website, tiers, accounts and the points ledger. */
@Module({
  controllers: [LoyaltyAdminController, AccountLoyaltyController],
  providers: [
    LoyaltyProgramsService,
    LoyaltyService,
    LoyaltyQuery,
    LoyaltyListener,
  ],
  exports: [LoyaltyService, LoyaltyQuery],
})
export class LoyaltyModule {}
