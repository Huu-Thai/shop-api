import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
} from 'class-validator';
import { CURRENCY_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { LoyaltyTransactionType } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpsertProgramDto {
  @ApiProperty({ example: 'Shop Rewards' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({
    example: 'USD',
    description: 'Currency orders are earned and redeemed in',
  })
  @Matches(CURRENCY_PATTERN)
  currencyCode: string;
  @ApiProperty({
    example: 100,
    description: 'Minor units spent per point (100 = 1 point per $1)',
  })
  @IsInt()
  @Min(1)
  spendPerPoint: number;
  @ApiProperty({
    example: 1,
    description: 'Minor units one redeemed point is worth',
  })
  @IsInt()
  @Min(1)
  pointValue: number;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minRedeemPoints?: number;
  @ApiPropertyOptional({
    default: 100,
    description: 'Share of an order points may pay',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxRedeemPercent?: number;
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Points expire after N days (null = never)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiryDays?: number | null;
  @ApiPropertyOptional({ default: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  tierWindowDays?: number;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class TierDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() thresholdPoints: number;
  @ApiProperty({ description: '10000 = ×1' }) multiplierBp: number;
}

export class ProgramDto {
  @ApiProperty() id: string;
  @ApiProperty() websiteId: string;
  @ApiProperty() name: string;
  @ApiProperty() currencyCode: string;
  @ApiProperty() spendPerPoint: string;
  @ApiProperty() pointValue: string;
  @ApiProperty() minRedeemPoints: number;
  @ApiProperty() maxRedeemPercent: number;
  @ApiProperty({ nullable: true, type: Number }) expiryDays: number | null;
  @ApiProperty() tierWindowDays: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [TierDto] }) tiers: TierDto[];
}

export class CreateTierDto {
  @ApiProperty({ example: 'gold' })
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_-]*$/)
  code: string;
  @ApiProperty({ example: 'Gold' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({
    example: 1000,
    description: 'Points earned within the window',
  })
  @IsInt()
  @Min(0)
  thresholdPoints: number;
  @ApiPropertyOptional({
    default: 10000,
    example: 15000,
    description: 'Earn multiplier in basis points',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  multiplierBp?: number;
}

export class UpdateTierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  thresholdPoints?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  multiplierBp?: number;
}

// ─── Ledger operations ───

export class EarnDto {
  @ApiProperty({ example: 'ORD-10001' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  orderRef: string;
  @ApiProperty({
    example: 12999,
    description:
      'Eligible amount in minor units (usually net of discounts and tax)',
  })
  @IsInt()
  @Min(0)
  amount: number;
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY_PATTERN)
  currencyCode: string;
}

export class RedeemPointsDto {
  @ApiProperty({ example: 'ORD-10001' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  orderRef: string;
  @ApiProperty({ example: 500 }) @IsInt() @Min(1) points: number;
  @ApiPropertyOptional({
    description:
      'Order total in minor units (enforces the max share points may pay)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  orderAmount?: number;
}

export class ReverseDto {
  @ApiProperty({ example: 'ORD-10001' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  orderRef: string;
  @ApiPropertyOptional({
    description:
      'Refunded eligible amount (minor units); omit for the whole order',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;
  @ApiPropertyOptional({
    description:
      'Give back points redeemed on the order (default: when the whole order is reversed)',
  })
  @IsOptional()
  @IsBoolean()
  restoreRedeemed?: boolean;
}

export class AdjustDto {
  @ApiProperty({
    example: 250,
    description: 'Positive credits points, negative removes them',
  })
  @IsInt()
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  points: number;
  @ApiProperty({ example: 'Goodwill for a late delivery' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class TransactionDto {
  @ApiProperty() id: string;
  @ApiProperty({
    enum: LoyaltyTransactionType,
    enumName: 'LoyaltyTransactionType',
  })
  type: LoyaltyTransactionType;
  @ApiProperty() points: number;
  @ApiProperty({ description: 'Points of this credit still spendable' })
  remaining: number;
  @ApiProperty({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiProperty({ nullable: true, type: String }) orderRef: string | null;
  @ApiProperty({ nullable: true, type: String }) note: string | null;
  @ApiProperty() createdAt: Date;
}

export class AccountDto {
  @ApiProperty() id: string;
  @ApiProperty() customerId: string;
  @ApiProperty() programId: string;
  @ApiProperty() balance: number;
  @ApiProperty() lifetimePoints: number;
  @ApiProperty({ nullable: true, type: TierDto }) tier: TierDto | null;
  @ApiProperty() createdAt: Date;
}

export class OperationResultDto {
  @ApiProperty({ type: AccountDto }) account: AccountDto;
  @ApiProperty({
    type: [TransactionDto],
    description: 'Transactions written (empty when nothing changed)',
  })
  transactions: TransactionDto[];
  @ApiPropertyOptional({
    description: 'For redemptions: the discount the points pay (minor units)',
  })
  value?: string;
}

export class ListTransactionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: LoyaltyTransactionType,
    enumName: 'LoyaltyTransactionType',
  })
  @IsOptional()
  @IsEnum(LoyaltyTransactionType)
  type?: LoyaltyTransactionType;
}

export class TransactionListDto {
  @ApiProperty({ type: [TransactionDto] }) data: TransactionDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListAccountsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() websiteId?: string;
  @ApiPropertyOptional({ description: 'Customer e-mail or name contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tierCode?: string;
}

export class AccountCustomerDto {
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

/** Back-office list row: the account with who owns it. */
export class AccountListItemDto extends AccountDto {
  @ApiProperty({ type: AccountCustomerDto }) customer: AccountCustomerDto;
}

export class AccountListDto {
  @ApiProperty({ type: [AccountListItemDto] }) data: AccountListItemDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

// ─── Storefront ───

export class StorefrontTierDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 1.5 }) multiplier: number;
}

export class StorefrontNextTierDto extends StorefrontTierDto {
  @ApiProperty({ description: 'Points still to earn within the window' })
  pointsNeeded: number;
}

export class StorefrontLoyaltyTransactionDto {
  @ApiProperty({
    enum: LoyaltyTransactionType,
    enumName: 'LoyaltyTransactionType',
  })
  type: LoyaltyTransactionType;
  @ApiProperty() points: number;
  @ApiProperty({ nullable: true, type: String }) orderRef: string | null;
  @ApiProperty({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class StorefrontLoyaltyDto {
  @ApiProperty() programName: string;
  @ApiProperty() balance: number;
  @ApiProperty({ example: '$5.00', description: 'What the balance is worth' })
  balanceValue: string;
  @ApiProperty() currencyCode: string;
  @ApiProperty() minRedeemPoints: number;
  @ApiProperty({ example: 1, description: 'Points per currency unit spent' })
  pointsPerUnit: number;
  @ApiProperty({ nullable: true, type: StorefrontTierDto })
  tier: StorefrontTierDto | null;
  @ApiProperty({ nullable: true, type: StorefrontNextTierDto })
  nextTier: StorefrontNextTierDto | null;
  @ApiProperty({ description: 'Points expiring within 30 days' })
  expiringSoon: number;
  @ApiProperty({ nullable: true, type: Date }) nextExpiryAt: Date | null;
  @ApiProperty({ type: [StorefrontLoyaltyTransactionDto] })
  recent: StorefrontLoyaltyTransactionDto[];
}
