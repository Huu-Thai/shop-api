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
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { PublishContentDto } from '../../common/content/content.dto.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import { CampaignsService } from './campaigns.service.js';
import { CouponsService } from './coupons.service.js';
import {
  CampaignDto,
  CampaignListDto,
  CouponDto,
  CouponListDto,
  CreateCampaignDto,
  CreateCouponDto,
  CreatePromotionDto,
  EvaluateCartDto,
  EvaluationDto,
  GenerateCouponsDto,
  GenerateCouponsResultDto,
  ListCouponsQueryDto,
  ListMarketingQueryDto,
  ListPromotionsQueryDto,
  PromotionDto,
  PromotionListDto,
  RedeemDto,
  RedemptionDto,
  ReleaseDto,
  RULE_MODELS,
  UpdateCampaignDto,
  UpdateCouponDto,
  UpdatePromotionDto,
  UsageDto,
} from './dto/marketing.dto.js';
import { PromotionsService } from './promotions.service.js';
import { RedemptionsService } from './redemptions.service.js';

const PUBLISH = 'Start now, or at `at`';
const UNPUBLISH = 'End now, or at `at`';

@ApiTags('admin · marketing')
@Controller('admin/marketing/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: CampaignListDto })
  list(@Query() q: ListMarketingQueryDto) {
    return this.campaigns.list(q);
  }

  @Get(':id')
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: CampaignDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(id);
  }

  @Post()
  @RequirePermissions('marketing:write')
  @ApiCreatedResponse({ type: CampaignDto })
  create(@Body() dto: CreateCampaignDto, @CurrentPrincipal() p: Principal) {
    return this.campaigns.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('marketing:write')
  @ApiOkResponse({ type: CampaignDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.campaigns.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.campaigns.remove(id, p);
  }

  @Post(':id/publish')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: `${PUBLISH}: its promotions and coupons apply while the campaign runs`,
  })
  @ApiOkResponse({ type: CampaignDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.campaigns.publish(id, 'publish', dto.at, p);
  }

  @Post(':id/unpublish')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH })
  @ApiOkResponse({ type: CampaignDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.campaigns.publish(id, 'unpublish', dto.at, p);
  }
}

@ApiTags('admin · marketing')
@ApiExtraModels(...RULE_MODELS)
@Controller('admin/marketing/promotions')
export class PromotionsController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly coupons: CouponsService,
    private readonly redemptions: RedemptionsService,
  ) {}

  @Get()
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: PromotionListDto })
  list(@Query() q: ListPromotionsQueryDto) {
    return this.promotions.list(q);
  }

  @Post('evaluate')
  @RequirePermissions('marketing:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Preview: which promotions a cart gets right now (with a coupon, a customer, a group)',
  })
  @ApiOkResponse({ type: EvaluationDto })
  evaluate(@Body() dto: EvaluateCartDto) {
    return this.redemptions.evaluate(dto);
  }

  @Get(':id')
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: PromotionDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.get(id);
  }

  @Post()
  @RequirePermissions('marketing:write')
  @ApiOperation({ summary: 'Create a cart promotion (as a draft)' })
  @ApiCreatedResponse({ type: PromotionDto })
  create(@Body() dto: CreatePromotionDto, @CurrentPrincipal() p: Principal) {
    return this.promotions.create(dto, p);
  }

  @Patch(':id')
  @RequirePermissions('marketing:write')
  @ApiOkResponse({ type: PromotionDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.promotions.update(id, dto, p);
  }

  @Delete(':id')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete (with its coupons); one used by orders can only be archived',
  })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.promotions.remove(id, p);
  }

  @Post(':id/publish')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: PUBLISH })
  @ApiOkResponse({ type: PromotionDto })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.promotions.publish(id, 'publish', dto.at, p);
  }

  @Post(':id/unpublish')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: UNPUBLISH })
  @ApiOkResponse({ type: PromotionDto })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishContentDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.promotions.publish(id, 'unpublish', dto.at, p);
  }

  @Get(':id/coupons')
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: CouponListDto })
  listCoupons(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListCouponsQueryDto,
  ) {
    return this.coupons.list(id, q);
  }

  @Post(':id/coupons')
  @RequirePermissions('marketing:write')
  @ApiCreatedResponse({ type: CouponDto })
  createCoupon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCouponDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.coupons.create(id, dto, p);
  }

  @Post(':id/coupons/generate')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Generate unique codes in the background (list them by batchId)',
  })
  @ApiAcceptedResponse({ type: GenerateCouponsResultDto })
  generate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateCouponsDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.coupons.generate(id, dto, p);
  }
}

@ApiTags('admin · marketing')
@Controller('admin/marketing')
export class CouponsAndUsageController {
  constructor(
    private readonly coupons: CouponsService,
    private readonly redemptions: RedemptionsService,
  ) {}

  @Patch('coupons/:id')
  @RequirePermissions('marketing:write')
  @ApiOkResponse({ type: CouponDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCouponDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.coupons.update(id, dto, p);
  }

  @Delete('coupons/:id')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unused coupon (deactivate used ones)' })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.coupons.remove(id, p);
  }

  @Post('redemptions')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record the promotions an order uses (re-evaluated; idempotent per orderRef; 409 when a limit was reached)',
  })
  @ApiOkResponse({ type: RedemptionDto })
  redeem(@Body() dto: RedeemDto, @CurrentPrincipal() p: Principal) {
    return this.redemptions.redeem(dto, actorOf(p));
  }

  @Post('redemptions/release')
  @RequirePermissions('marketing:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The order was cancelled: give its promotion and coupon uses back',
  })
  @ApiOkResponse({ type: [UsageDto] })
  release(@Body() dto: ReleaseDto, @CurrentPrincipal() p: Principal) {
    return this.redemptions.release(dto.orderRef, actorOf(p));
  }

  @Get('redemptions/:orderRef')
  @RequirePermissions('marketing:read')
  @ApiOkResponse({ type: [UsageDto] })
  usages(@Param('orderRef') orderRef: string) {
    return this.redemptions.usages(orderRef);
  }
}
