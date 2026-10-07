import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
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
import {
  CODE_MESSAGE,
  CODE_PATTERN,
  CURRENCY_PATTERN,
} from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

export class PriceBookDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'us-retail' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'USD' }) currencyCode: string;
  @ApiProperty({ nullable: true, type: String }) websiteId: string | null;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty({ nullable: true, type: String }) customerGroupId: string | null;
  @ApiProperty() includesTax: boolean;
  @ApiProperty({ description: 'Lower wins' }) priority: number;
  @ApiProperty({ nullable: true, type: Date }) validFrom: Date | null;
  @ApiProperty({ nullable: true, type: Date }) validTo: Date | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty() entryCount: number;
}

class PriceBookFields {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Limit to one website (exclusive with storeId)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  websiteId?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Limit to one store',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Limit to one customer group',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  customerGroupId?: string | null;
  @ApiPropertyOptional({
    default: 100,
    description: 'Lower wins; ties go to the more specific book',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  priority?: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  validFrom?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  validTo?: string | null;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreatePriceBookDto extends PriceBookFields {
  @ApiProperty({ example: 'us-retail' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'US retail' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY_PATTERN)
  currencyCode: string;
  @ApiPropertyOptional({
    default: false,
    description:
      'Amounts are entered tax-inclusive (EU/VN) instead of net (US)',
  })
  @IsOptional()
  @IsBoolean()
  includesTax?: boolean;
}

/** Currency and tax mode are fixed: they give the entries their meaning. */
export class UpdatePriceBookDto extends PriceBookFields {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
}

export class PriceEntryInputDto {
  @ApiPropertyOptional({ description: 'Variant id, or…' })
  @IsOptional()
  @IsUUID()
  variantId?: string;
  @ApiPropertyOptional({ example: 'TEE-RED-M', description: '…variant SKU' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minQty?: number;
  @ApiProperty({ example: 2599, description: 'Unit price in minor units' })
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  amount: number;
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: '"Was" price in minor units',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  compareAtAmount?: number | null;
}

export class SetPriceEntriesDto {
  @ApiProperty({
    type: [PriceEntryInputDto],
    description: 'Upserted by (variant, minQty)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => PriceEntryInputDto)
  entries: PriceEntryInputDto[];
}

export class PriceEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() variantId: string;
  @ApiProperty() sku: string;
  @ApiProperty() minQty: number;
  @ApiProperty() amount: number;
  @ApiProperty({ nullable: true, type: Number }) compareAtAmount: number | null;
}

export class PriceEntryListDto {
  @ApiProperty({ type: [PriceEntryDto] }) data: PriceEntryDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListPriceEntriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ description: 'Entries of every variant of a product' })
  @IsOptional()
  @IsUUID()
  productId?: string;
  @ApiPropertyOptional({ description: 'SKU contains (case-insensitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

export class ExchangeRateDto {
  @ApiProperty({ example: 'USD' }) baseCurrencyCode: string;
  @ApiProperty({ example: 'VND' }) quoteCurrencyCode: string;
  @ApiProperty({
    example: '25400.00000000',
    description: 'Quote units per 1 base unit',
  })
  rate: string;
  @ApiProperty() validFrom: Date;
}

export class CreateExchangeRateDto {
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY_PATTERN)
  baseCurrencyCode: string;
  @ApiProperty({ example: 'VND' })
  @Matches(CURRENCY_PATTERN)
  quoteCurrencyCode: string;
  @ApiProperty({ example: '25400' })
  @Matches(/^\d{1,10}(\.\d{1,8})?$/, {
    message: 'rate must be a positive decimal (8 decimals max)',
  })
  rate: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() validFrom?: string;
}

export class PricePreviewQueryDto {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional({ default: 'guest' })
  @IsOptional()
  @Matches(CODE_PATTERN)
  customerGroup?: string;
  @ApiPropertyOptional({ description: 'Defaults to the store currency' })
  @IsOptional()
  @Matches(CURRENCY_PATTERN)
  currency?: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;
  @ApiPropertyOptional({ description: 'Evaluate at another time (ISO)' })
  @IsOptional()
  @IsDateString()
  at?: string;
}

export class PricePreviewTierDto {
  @ApiProperty() minQty: number;
  @ApiProperty() net: number;
  @ApiProperty() gross: number;
  @ApiProperty() priceBook: string;
}

export class PricePreviewDto {
  @ApiProperty({ type: [String], description: 'Matching books, best first' })
  books: string[];
  @ApiProperty({ type: [PricePreviewTierDto] }) tiers: PricePreviewTierDto[];
  @ApiProperty({
    nullable: true,
    type: PricePreviewTierDto,
    description: 'The tier for qty',
  })
  applied: PricePreviewTierDto | null;
  @ApiProperty() qty: number;
  @ApiProperty({
    description: 'Line totals for qty at the store’s default destination',
  })
  lineNet: number;
  @ApiProperty() lineTax: number;
  @ApiProperty() lineGross: number;
  @ApiProperty({ example: '19.0000' }) taxRate: string;
  @ApiProperty() currency: string;
}

export class ReindexDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Variants to reindex; omit for everything',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsUUID('all', { each: true })
  variantIds?: string[];
}
