import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PublishingDto } from '../../../common/content/content.dto.js';
import { CURRENCY_PATTERN, LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { ContentStatus } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const CAMPAIGN_CODE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const COUPON_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

// ─── Campaigns ───

export class CreateCampaignDto {
  @ApiProperty({ example: 'black-friday-2026' })
  @MaxLength(64)
  @Matches(CAMPAIGN_CODE_PATTERN)
  code: string;
  @ApiProperty({ example: 'Black Friday 2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
  @ApiPropertyOptional({ description: 'Budget in minor units (informational)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetAmount?: number;
  @ApiPropertyOptional({ example: 'USD' })
  @ValidateIf((o: CreateCampaignDto) => o.budgetAmount !== undefined)
  @Matches(CURRENCY_PATTERN)
  budgetCurrencyCode?: string;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  budgetAmount?: number | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(CURRENCY_PATTERN)
  budgetCurrencyCode?: string | null;
}

export class CampaignDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Minor units' })
  budgetAmount: string | null;
  @ApiProperty({ nullable: true, type: String }) budgetCurrencyCode:
    string | null;
  @ApiProperty() promotionCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class ListMarketingQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ContentStatus, enumName: 'ContentStatus' })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CampaignListDto {
  @ApiProperty({ type: [CampaignDto] }) data: CampaignDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

// ─── Promotions ───

export class PromotionLabelDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: '10% off tees' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  label: string;
}

// ─── Rule shapes (OpenAPI only; `promotion-rules.ts` validates and normalizes) ───

const AMOUNTS = {
  type: 'object',
  additionalProperties: { type: 'integer' },
  example: { USD: 5000 },
  description: 'Minor units per currency code',
} as const;

export class RuleItemFilterDto {
  @ApiPropertyOptional({ type: [String] }) skus?: string[];
  @ApiPropertyOptional({ type: [String] }) productIds?: string[];
  @ApiPropertyOptional({ type: [String] }) categoryIds?: string[];
}

export class SubtotalAtLeastConditionDto {
  @ApiProperty({ enum: ['subtotal_at_least'] }) type: 'subtotal_at_least';
  @ApiProperty(AMOUNTS) amounts: Record<string, number>;
}

export class ItemQuantityAtLeastConditionDto {
  @ApiProperty({ enum: ['item_quantity_at_least'] })
  type: 'item_quantity_at_least';
  @ApiProperty({ minimum: 1, maximum: 10_000 }) quantity: number;
  @ApiPropertyOptional({ type: RuleItemFilterDto }) filter?: RuleItemFilterDto;
}

export class CustomerGroupConditionDto {
  @ApiProperty({ enum: ['customer_group'] }) type: 'customer_group';
  @ApiProperty({ type: [String] }) groups: string[];
}

export class PercentOffItemsActionDto {
  @ApiProperty({ enum: ['percent_off_items'] }) type: 'percent_off_items';
  @ApiProperty({ minimum: 0.01, maximum: 100 }) percent: number;
  @ApiPropertyOptional({ type: RuleItemFilterDto }) filter?: RuleItemFilterDto;
  @ApiPropertyOptional({ minimum: 1 }) maxQuantity?: number;
}

export class FixedOffItemsActionDto {
  @ApiProperty({ enum: ['fixed_off_items'] }) type: 'fixed_off_items';
  @ApiProperty({ ...AMOUNTS, description: 'Off each unit, minor units' })
  amounts: Record<string, number>;
  @ApiPropertyOptional({ type: RuleItemFilterDto }) filter?: RuleItemFilterDto;
  @ApiPropertyOptional({ minimum: 1 }) maxQuantity?: number;
}

export class PercentOffCartActionDto {
  @ApiProperty({ enum: ['percent_off_cart'] }) type: 'percent_off_cart';
  @ApiProperty({ minimum: 0.01, maximum: 100 }) percent: number;
}

export class FixedOffCartActionDto {
  @ApiProperty({ enum: ['fixed_off_cart'] }) type: 'fixed_off_cart';
  @ApiProperty(AMOUNTS) amounts: Record<string, number>;
}

export class BuyXGetYActionDto {
  @ApiProperty({ enum: ['buy_x_get_y'] }) type: 'buy_x_get_y';
  @ApiProperty({ minimum: 1, maximum: 1000 }) buy: number;
  @ApiProperty({ minimum: 1, maximum: 1000 }) get: number;
  @ApiPropertyOptional({ default: 100, minimum: 0.01, maximum: 100 })
  percent?: number;
  @ApiPropertyOptional({ type: RuleItemFilterDto }) filter?: RuleItemFilterDto;
}

export class FreeShippingActionDto {
  @ApiProperty({ enum: ['free_shipping'] }) type: 'free_shipping';
}

/** Registered with `@ApiExtraModels` on the promotions controller. */
export const RULE_MODELS = [
  SubtotalAtLeastConditionDto,
  ItemQuantityAtLeastConditionDto,
  CustomerGroupConditionDto,
  PercentOffItemsActionDto,
  FixedOffItemsActionDto,
  PercentOffCartActionDto,
  FixedOffCartActionDto,
  BuyXGetYActionDto,
  FreeShippingActionDto,
];

const ruleList = (models: (new () => { type: string })[], types: string[]) => ({
  type: 'array' as const,
  items: {
    oneOf: models.map((m) => ({ $ref: getSchemaPath(m) })),
    discriminator: {
      propertyName: 'type',
      mapping: Object.fromEntries(
        types.map((t, i) => [t, getSchemaPath(models[i])]),
      ),
    },
  },
});
const CONDITIONS_SCHEMA = ruleList(
  [
    SubtotalAtLeastConditionDto,
    ItemQuantityAtLeastConditionDto,
    CustomerGroupConditionDto,
  ],
  ['subtotal_at_least', 'item_quantity_at_least', 'customer_group'],
);
const ACTIONS_SCHEMA = ruleList(
  [
    PercentOffItemsActionDto,
    FixedOffItemsActionDto,
    PercentOffCartActionDto,
    FixedOffCartActionDto,
    BuyXGetYActionDto,
    FreeShippingActionDto,
  ],
  [
    'percent_off_items',
    'fixed_off_items',
    'percent_off_cart',
    'fixed_off_cart',
    'buy_x_get_y',
    'free_shipping',
  ],
);
export type RuleCondition =
  | SubtotalAtLeastConditionDto
  | ItemQuantityAtLeastConditionDto
  | CustomerGroupConditionDto;
export type RuleAction =
  | PercentOffItemsActionDto
  | FixedOffItemsActionDto
  | PercentOffCartActionDto
  | FixedOffCartActionDto
  | BuyXGetYActionDto
  | FreeShippingActionDto;

const RULES_DOC = `Conditions (all must hold): {type: "subtotal_at_least", amounts: {USD: 5000}} · {type: "item_quantity_at_least", quantity, filter?} · {type: "customer_group", groups: ["wholesale"]}.
Actions (in order): {type: "percent_off_items", percent, filter?, maxQuantity?} · {type: "fixed_off_items", amounts, filter?, maxQuantity?} (per unit) · {type: "percent_off_cart", percent} · {type: "fixed_off_cart", amounts} · {type: "buy_x_get_y", buy, get, percent? (default 100), filter?} · {type: "free_shipping"}.
filter = {skus?, productIds?, categoryIds?} (any of). Amounts are minor units per currency.`;

export class CreatePromotionDto {
  @ApiProperty({ example: 'Tees 10% off' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Only active while the campaign is',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  campaignId?: string | null;
  @ApiProperty({ type: [String], description: 'Websites where it applies' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  websiteIds: string[];
  @ApiPropertyOptional({ default: 0, description: 'Lower runs first' })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
  @ApiPropertyOptional({
    default: false,
    description: 'No later promotion applies after this one',
  })
  @IsOptional()
  @IsBoolean()
  stopFurther?: boolean;
  @ApiPropertyOptional({
    default: false,
    description: 'Applies only with one of its coupons',
  })
  @IsOptional()
  @IsBoolean()
  requiresCoupon?: boolean;
  @ApiProperty({
    ...CONDITIONS_SCHEMA,
    description: RULES_DOC,
    example: [{ type: 'subtotal_at_least', amounts: { USD: 5000 } }],
  })
  @IsArray()
  conditions: unknown[];
  @ApiProperty({
    ...ACTIONS_SCHEMA,
    example: [{ type: 'percent_off_cart', percent: 10 }],
  })
  @IsArray()
  actions: unknown[];
  @ApiPropertyOptional({ description: 'Total uses across all orders' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;
  @ApiPropertyOptional({ description: 'Uses per signed-in customer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usesPerCustomer?: number;
  @ApiPropertyOptional({ type: [PromotionLabelDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PromotionLabelDto)
  labels?: PromotionLabelDto[];
}

export class UpdatePromotionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  campaignId?: string | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  websiteIds?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stopFurther?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresCoupon?: boolean;
  @ApiPropertyOptional({ ...CONDITIONS_SCHEMA, description: RULES_DOC })
  @IsOptional()
  @IsArray()
  conditions?: unknown[];
  @ApiPropertyOptional(ACTIONS_SCHEMA)
  @IsOptional()
  @IsArray()
  actions?: unknown[];
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  usageLimit?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  usesPerCustomer?: number | null;
  @ApiPropertyOptional({
    type: [PromotionLabelDto],
    description: 'Replaces the labels',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PromotionLabelDto)
  labels?: PromotionLabelDto[];
}

export class PromotionDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String }) campaignId: string | null;
  @ApiProperty({ type: [String] }) websiteIds: string[];
  @ApiProperty() priority: number;
  @ApiProperty() stopFurther: boolean;
  @ApiProperty() requiresCoupon: boolean;
  @ApiProperty(CONDITIONS_SCHEMA) conditions: RuleCondition[];
  @ApiProperty(ACTIONS_SCHEMA) actions: RuleAction[];
  @ApiProperty({ nullable: true, type: Number }) usageLimit: number | null;
  @ApiProperty({ nullable: true, type: Number }) usesPerCustomer: number | null;
  @ApiProperty() timesUsed: number;
  @ApiProperty({ type: [PromotionLabelDto] }) labels: PromotionLabelDto[];
  @ApiProperty({
    description: 'Applies right now (its window and its campaign’s)',
  })
  active: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class ListPromotionsQueryDto extends ListMarketingQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() campaignId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() websiteId?: string;
}

export class PromotionListDto {
  @ApiProperty({ type: [PromotionDto] }) data: PromotionDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

// ─── Coupons ───

export class CreateCouponDto {
  @ApiProperty({ example: 'SUMMER10' })
  @Matches(COUPON_CODE_PATTERN)
  code: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) usageLimit?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  usesPerCustomer?: number;
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class GenerateCouponsDto {
  @ApiProperty({ minimum: 1, maximum: 100_000 })
  @IsInt()
  @Min(1)
  @Max(100_000)
  count: number;
  @ApiPropertyOptional({ example: 'BF-', description: 'Code prefix' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/)
  prefix?: string;
  @ApiPropertyOptional({
    default: 10,
    minimum: 6,
    maximum: 32,
    description: 'Random characters after the prefix',
  })
  @IsOptional()
  @IsInt()
  @Min(6)
  @Max(32)
  length?: number;
  @ApiPropertyOptional({ default: 1, description: 'Uses per code' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  usesPerCustomer?: number;
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class UpdateCouponDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  usageLimit?: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  usesPerCustomer?: number | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601({ strict: true })
  expiresAt?: string | null;
}

export class CouponDto {
  @ApiProperty() id: string;
  @ApiProperty() promotionId: string;
  @ApiProperty() code: string;
  @ApiProperty({ nullable: true, type: Number }) usageLimit: number | null;
  @ApiProperty({ nullable: true, type: Number }) usesPerCustomer: number | null;
  @ApiProperty() timesUsed: number;
  @ApiProperty({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ nullable: true, type: String }) batchId: string | null;
  @ApiProperty() createdAt: Date;
}

export class ListCouponsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional({ description: 'Code starts with' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

export class CouponListDto {
  @ApiProperty({ type: [CouponDto] }) data: CouponDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class GenerateCouponsResultDto {
  @ApiProperty() batchId: string;
  @ApiProperty() count: number;
}

// ─── Evaluation and usage ───

export class CartLineInputDto {
  @ApiProperty({ example: 'TEE-RED-M' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(10_000) quantity: number;
  @ApiProperty({ example: 2500, description: 'Unit price in minor units' })
  @IsInt()
  @Min(0)
  unitPrice: number;
}

export class EvaluateCartDto {
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY_PATTERN)
  currencyCode: string;
  @ApiPropertyOptional({
    description: 'Customer group code; default guest (or the customer’s)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerGroupCode?: string;
  @ApiPropertyOptional({
    description: 'Signed-in customer (per-customer limits)',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(COUPON_CODE_PATTERN)
  couponCode?: string;
  @ApiProperty({ type: [CartLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CartLineInputDto)
  items: CartLineInputDto[];
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  shippingAmount?: number;
  @ApiPropertyOptional({
    example: 'en-US',
    description: 'Locale of the labels',
  })
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
}

export enum CouponStatus {
  APPLIED = 'APPLIED',
  NOT_FOUND = 'NOT_FOUND',
  INACTIVE = 'INACTIVE',
  EXPIRED = 'EXPIRED',
  USED_UP = 'USED_UP',
  /** The signed-in customer reached their own limit. */
  ALREADY_USED = 'ALREADY_USED',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export class CouponResultDto {
  @ApiProperty() code: string;
  @ApiProperty({ enum: CouponStatus, enumName: 'CouponStatus' })
  status: CouponStatus;
  @ApiProperty() message: string;
}

export class AppliedPromotionDto {
  @ApiProperty() promotionId: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: 'Minor units' }) discount: string;
  @ApiProperty() freeShipping: boolean;
  @ApiProperty({ nullable: true, type: String }) couponCode: string | null;
}

export class EvaluatedLineDto {
  @ApiProperty() sku: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ description: 'Minor units' }) lineTotal: string;
  @ApiProperty({ description: 'Minor units' }) discount: string;
}

export class EvaluationDto {
  @ApiProperty() currencyCode: string;
  @ApiProperty() subtotal: string;
  @ApiProperty() discountTotal: string;
  @ApiProperty() total: string;
  @ApiProperty() freeShipping: boolean;
  @ApiProperty() shippingDiscount: string;
  @ApiProperty({ type: [EvaluatedLineDto] }) lines: EvaluatedLineDto[];
  @ApiProperty({ type: [AppliedPromotionDto] }) applied: AppliedPromotionDto[];
  @ApiProperty({ nullable: true, type: CouponResultDto })
  coupon: CouponResultDto | null;
  @ApiProperty({
    type: [String],
    description: 'SKUs that are not sold (ignored)',
  })
  unknownSkus: string[];
}

export class RedeemDto extends EvaluateCartDto {
  @ApiProperty({
    example: 'ORD-10001',
    description: 'Order reference (idempotency key)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  orderRef: string;
}

export class ReleaseDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) orderRef: string;
}

export class UsageDto {
  @ApiProperty() id: string;
  @ApiProperty() promotionId: string;
  @ApiProperty({ nullable: true, type: String }) couponId: string | null;
  @ApiProperty({ nullable: true, type: String }) customerId: string | null;
  @ApiProperty() orderRef: string;
  @ApiProperty() discount: string;
  @ApiProperty() currencyCode: string;
  @ApiProperty({ enum: ['APPLIED', 'RELEASED'] }) status:
    'APPLIED' | 'RELEASED';
  @ApiProperty() createdAt: Date;
}

export class RedemptionDto {
  @ApiProperty({ type: EvaluationDto }) evaluation: EvaluationDto;
  @ApiProperty({ type: [UsageDto] }) usages: UsageDto[];
}
