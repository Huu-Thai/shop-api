import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  COUNTRY_PATTERN,
  CURRENCY_PATTERN,
  LOCALE_PATTERN,
} from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  PaymentMode,
  PaymentProviderCode,
  PaymentStatus,
  WebhookStatus,
} from '../../../database/generated/prisma/enums.js';
import { MoneyDto } from '../../carts/dto/cart.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const URL_PATTERN = /^https?:\/\/[^\s]+$/;

// ─── Storefront ───

export class PaymentMethodDto {
  @ApiProperty({ example: 'card' }) code: string;
  @ApiProperty({ example: 'Credit or debit card' }) title: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ enum: PaymentProviderCode, enumName: 'PaymentProviderCode' })
  provider: PaymentProviderCode;
}

export class PayOrderDto {
  @ApiProperty({
    example: 'card',
    description: 'A code from the order’s payment methods',
  })
  @IsString()
  @MaxLength(64)
  method: string;
  @ApiProperty({
    example: 'https://shop.example/checkout/return',
    description: 'Where the provider sends the shopper back',
  })
  @Matches(URL_PATTERN)
  @MaxLength(1000)
  returnUrl: string;
  @ApiPropertyOptional({
    description:
      'Where the shopper lands when they cancel (defaults to returnUrl)',
  })
  @IsOptional()
  @Matches(URL_PATTERN)
  @MaxLength(1000)
  cancelUrl?: string;
}

export class PaymentActionDto {
  @ApiProperty({ enum: ['REDIRECT', 'CLIENT_SECRET', 'NONE'] }) type: string;
  @ApiPropertyOptional({ description: 'REDIRECT: send the shopper here' })
  url?: string;
  @ApiPropertyOptional({ description: 'Wallet app link (MoMo)' })
  deeplink?: string;
  @ApiPropertyOptional({ description: 'QR code image (MoMo)' })
  qrCodeUrl?: string;
  @ApiPropertyOptional({ description: 'CLIENT_SECRET: confirm with Stripe.js' })
  clientSecret?: string;
  @ApiPropertyOptional() publishableKey?: string;
}

export class PaymentDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status: PaymentStatus;
  @ApiProperty({ enum: PaymentProviderCode, enumName: 'PaymentProviderCode' })
  provider: PaymentProviderCode;
  @ApiProperty({ nullable: true, type: String }) method: string | null;
  @ApiProperty({ type: MoneyDto }) amount: MoneyDto;
  @ApiProperty({
    nullable: true,
    type: PaymentActionDto,
    description: 'What to do next while PENDING',
  })
  action: PaymentActionDto | null;
  @ApiProperty({ nullable: true, type: String }) failureReason: string | null;
  @ApiProperty() createdAt: Date;
}

export class PaymentReturnDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'The query parameters the provider appended to the return URL, as received',
  })
  @IsObject()
  params: Record<string, string>;
}

// ─── Admin: providers and store methods ───

export class CreateProviderDto {
  @ApiProperty({ enum: PaymentProviderCode, enumName: 'PaymentProviderCode' })
  @IsEnum(PaymentProviderCode)
  code: PaymentProviderCode;
  @ApiProperty({ example: 'Stripe (US)' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    enum: PaymentMode,
    enumName: 'PaymentMode',
    default: 'TEST',
  })
  @IsOptional()
  @IsEnum(PaymentMode)
  mode?: PaymentMode;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'STRIPE: secretKey, publishableKey, webhookSecret · PAYPAL: clientId, clientSecret, webhookId · VNPAY: tmnCode, hashSecret · MOMO: partnerCode, accessKey, secretKey (sealed at rest, never returned)',
  })
  @IsOptional()
  @IsObject()
  credentials?: Record<string, string>;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ enum: PaymentMode, enumName: 'PaymentMode' })
  @IsOptional()
  @IsEnum(PaymentMode)
  mode?: PaymentMode;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Replaces the credentials',
  })
  @IsOptional()
  @IsObject()
  credentials?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ProviderDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PaymentProviderCode, enumName: 'PaymentProviderCode' })
  code: PaymentProviderCode;
  @ApiProperty() name: string;
  @ApiProperty({ enum: PaymentMode, enumName: 'PaymentMode' })
  mode: PaymentMode;
  @ApiProperty() isActive: boolean;
  @ApiProperty({
    description: 'Credentials are stored (they are never returned)',
  })
  configured: boolean;
  @ApiProperty({
    example: 'https://api.shop.example/api/v1/webhooks/payments/…',
    description: 'Register this URL with the provider',
  })
  webhookUrl: string;
}

export class MethodTitleDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Card' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  title: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateStoreMethodDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty() @IsUUID() providerId: string;
  @ApiProperty({ example: 'card' })
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/)
  code: string;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { USD: 100 },
    description: 'Minor units per currency',
  })
  @IsOptional()
  @IsObject()
  minAmounts?: Record<string, number>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { VND: 50000000 },
    description: 'Minor units per currency',
  })
  @IsOptional()
  @IsObject()
  maxAmounts?: Record<string, number>;
  @ApiPropertyOptional({
    type: [String],
    description: 'Billing countries (empty = all)',
  })
  @IsOptional()
  @IsArray()
  @Matches(COUNTRY_PATTERN, { each: true })
  countryCodes?: string[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Order currencies (empty = all)',
  })
  @IsOptional()
  @IsArray()
  @Matches(CURRENCY_PATTERN, { each: true })
  currencyCodes?: string[];
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiProperty({ type: [MethodTitleDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MethodTitleDto)
  titles: MethodTitleDto[];
}

export class UpdateStoreMethodDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Minor units by currency code',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  minAmounts?: Record<string, number> | null;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Minor units by currency code',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  maxAmounts?: Record<string, number> | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(COUNTRY_PATTERN, { each: true })
  countryCodes?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(CURRENCY_PATTERN, { each: true })
  currencyCodes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({
    type: [MethodTitleDto],
    description: 'Replaces the titles',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MethodTitleDto)
  titles?: MethodTitleDto[];
}

export class StoreMethodDto {
  @ApiProperty() id: string;
  @ApiProperty() storeId: string;
  @ApiProperty() providerId: string;
  @ApiProperty() code: string;
  @ApiProperty() position: number;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  minAmounts: Record<string, number> | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  maxAmounts: Record<string, number> | null;
  @ApiProperty({ type: [String] }) countryCodes: string[];
  @ApiProperty({ type: [String] }) currencyCodes: string[];
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [MethodTitleDto] }) titles: MethodTitleDto[];
}

// ─── Admin: payments, refunds, webhooks ───

export class RefundItemDto {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
}

export class CreateRefundDto {
  @ApiPropertyOptional({
    description:
      'Minor units; default = the items’ value, or everything still refundable',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;
  @ApiPropertyOptional({
    type: [RefundItemDto],
    description: 'Returned lines (for restocking and the credit memo)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RefundItemDto)
  items?: RefundItemDto[];
  @ApiPropertyOptional({
    default: false,
    description: 'Put the returned units back in stock',
  })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
  @ApiPropertyOptional({ example: 'Damaged on arrival' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RefundDto {
  @ApiProperty() id: string;
  @ApiProperty() paymentId: string;
  @ApiProperty({ type: MoneyDto }) amount: MoneyDto;
  @ApiProperty({ enum: ['PENDING', 'SUCCEEDED', 'FAILED'] }) status: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ nullable: true, type: String }) providerRef: string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason: string | null;
  @ApiProperty() restock: boolean;
  @ApiProperty() createdAt: Date;
}

/** A provider call on a payment (authorize, capture, refund…). */
export class PaymentTransactionDto {
  @ApiProperty() type: string;
  @ApiProperty({ type: MoneyDto }) amount: MoneyDto;
  @ApiProperty() succeeded: boolean;
  @ApiProperty({ nullable: true, type: String }) providerRef: string | null;
  @ApiProperty() source: string;
  @ApiProperty() createdAt: Date;
}

export class AdminPaymentDto extends PaymentDto {
  @ApiProperty({ nullable: true, type: String }) providerRef: string | null;
  @ApiProperty({ nullable: true, type: String }) captureRef: string | null;
  @ApiProperty({ type: MoneyDto }) amountRefunded: MoneyDto;
  @ApiProperty({ nullable: true, type: Date }) capturedAt: Date | null;
  @ApiProperty({ type: [PaymentTransactionDto] })
  transactions: PaymentTransactionDto[];
}

export class OrderPaymentsDto {
  @ApiProperty({ type: [AdminPaymentDto] }) payments: AdminPaymentDto[];
  @ApiProperty({ type: [RefundDto] }) refunds: RefundDto[];
}

export class ListWebhooksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WebhookStatus, enumName: 'WebhookStatus' })
  @IsOptional()
  @IsEnum(WebhookStatus)
  status?: WebhookStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() providerId?: string;
}

export class WebhookEventDto {
  @ApiProperty() id: string;
  @ApiProperty() providerId: string;
  @ApiProperty() providerEventId: string;
  @ApiProperty() eventType: string;
  @ApiProperty({ enum: WebhookStatus, enumName: 'WebhookStatus' })
  status: WebhookStatus;
  @ApiProperty({ nullable: true, type: String }) error: string | null;
  @ApiProperty() receivedAt: Date;
}

export class WebhookEventListDto {
  @ApiProperty({ type: [WebhookEventDto] }) data: WebhookEventDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class RefundSettlementDto {
  @ApiProperty() checked: number;
  @ApiProperty() settled: number;
}

export class ReconcileResultDto {
  @ApiProperty({ description: 'Pending payments asked about' })
  checked: number;
  @ApiProperty({ description: 'Payments whose status changed' })
  changed: number;
  @ApiProperty({ type: RefundSettlementDto, description: 'Pending refunds' })
  refunds: RefundSettlementDto;
}
