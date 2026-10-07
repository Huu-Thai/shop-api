import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { StorefrontAccount } from '../stores/context/storefront.decorator.js';
import {
  CurrentCustomer,
  type StoreContext,
  StoreCtx,
  type StorefrontCustomer,
} from '../stores/context/store-context.js';
import {
  AccountDto,
  AccountListDto,
  AdjustDto,
  CreateTierDto,
  EarnDto,
  ListAccountsQueryDto,
  ListTransactionsQueryDto,
  OperationResultDto,
  ProgramDto,
  RedeemPointsDto,
  ReverseDto,
  StorefrontLoyaltyDto,
  TierDto,
  TransactionListDto,
  UpdateTierDto,
  UpsertProgramDto,
} from './dto/loyalty.dto.js';
import { LoyaltyProgramsService } from './loyalty-programs.service.js';
import { LoyaltyQuery } from './loyalty.query.js';
import { LoyaltyService } from './loyalty.service.js';

@ApiTags('admin · loyalty')
@Controller('admin/loyalty')
export class LoyaltyAdminController {
  constructor(
    private readonly programs: LoyaltyProgramsService,
    private readonly ledger: LoyaltyService,
    private readonly query: LoyaltyQuery,
  ) {}

  @Get('programs')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: [ProgramDto] })
  listPrograms() {
    return this.programs.list();
  }

  @Get('programs/:websiteId')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: ProgramDto })
  getProgram(@Param('websiteId', ParseUUIDPipe) websiteId: string) {
    return this.programs.get(websiteId);
  }

  @Put('programs/:websiteId')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Create or change the loyalty program of a website',
  })
  @ApiOkResponse({ type: ProgramDto })
  upsertProgram(
    @Param('websiteId', ParseUUIDPipe) websiteId: string,
    @Body() dto: UpsertProgramDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.programs.upsert(websiteId, dto, p);
  }

  @Post('programs/:websiteId/tiers')
  @RequirePermissions('customers:write')
  @ApiCreatedResponse({ type: TierDto })
  addTier(
    @Param('websiteId', ParseUUIDPipe) websiteId: string,
    @Body() dto: CreateTierDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.programs.addTier(websiteId, dto, p);
  }

  @Patch('tiers/:id')
  @RequirePermissions('customers:write')
  @ApiOkResponse({ type: TierDto })
  updateTier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTierDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.programs.updateTier(id, dto, p);
  }

  @Delete('tiers/:id')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeTier(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.programs.removeTier(id, p);
  }

  @Get('accounts')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: AccountListDto })
  accounts(@Query() q: ListAccountsQueryDto) {
    return this.query.accounts(q);
  }

  @Get('customers/:customerId')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: AccountDto })
  account(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.query.accountOf(customerId);
  }

  @Get('customers/:customerId/transactions')
  @RequirePermissions('customers:read')
  @ApiOkResponse({ type: TransactionListDto })
  transactions(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() q: ListTransactionsQueryDto,
  ) {
    return this.query.transactions(customerId, q);
  }

  @Post('customers/:customerId/earn')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Points for a paid order (idempotent per orderRef; checkout calls this in Phase 6)',
  })
  @ApiOkResponse({ type: OperationResultDto })
  earn(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: EarnDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ledger.earn(customerId, dto, actorOf(p));
  }

  @Post('customers/:customerId/redeem')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Spend points on an order (idempotent per orderRef)',
  })
  @ApiOkResponse({ type: OperationResultDto })
  redeem(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: RedeemPointsDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ledger.redeem(customerId, dto, actorOf(p));
  }

  @Post('customers/:customerId/reverse')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Refund or cancellation: take back earned points (in proportion to the amount) and return redeemed ones',
  })
  @ApiOkResponse({ type: OperationResultDto })
  reverse(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: ReverseDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ledger.reverse(customerId, dto, actorOf(p));
  }

  @Post('customers/:customerId/adjust')
  @RequirePermissions('customers:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Credit or remove points by hand (with a note)' })
  @ApiOkResponse({ type: OperationResultDto })
  adjust(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AdjustDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.ledger.adjust(customerId, dto, actorOf(p));
  }
}

@StorefrontAccount()
@Controller('store/account/loyalty')
export class AccountLoyaltyController {
  constructor(private readonly query: LoyaltyQuery) {}

  @Get()
  @ApiOperation({
    summary:
      'My points: balance and its worth, tier progress, expiring points, recent activity',
    operationId: 'getLoyalty',
  })
  @ApiOkResponse({ type: StorefrontLoyaltyDto })
  async get(
    @StoreCtx() ctx: StoreContext,
    @CurrentCustomer() c: StorefrontCustomer,
  ) {
    const s = await this.query.summary(c, ctx.localeCode);
    if (!s) throw new NotFoundException('This store has no loyalty program');
    return s;
  }
}
