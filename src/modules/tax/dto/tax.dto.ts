import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
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
  CODE_MESSAGE,
  CODE_PATTERN,
  COUNTRY_PATTERN,
} from '../../../common/dto/codes.js';
import { TaxClassType } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export const PERCENT_PATTERN = /^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/;

export class TaxClassDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'reduced' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: TaxClassType, enumName: 'TaxClassType' })
  type: TaxClassType;
}

export class CreateTaxClassDto {
  @ApiProperty({ example: 'reduced' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({ enum: TaxClassType, enumName: 'TaxClassType' })
  @IsEnum(TaxClassType)
  type: TaxClassType;
}

export class UpdateTaxClassDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
}

export class TaxZoneRegionDto {
  @ApiProperty({ example: 'US' }) @Matches(COUNTRY_PATTERN) countryCode: string;
  @ApiPropertyOptional({
    example: 'CA',
    nullable: true,
    type: String,
    description: 'Subdivision; omit for the whole country',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(16)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  regionCode?: string | null;
  @ApiPropertyOptional({
    example: '900*',
    nullable: true,
    type: String,
    description: '`*` wildcard; omit for every postcode',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  postcodePattern?: string | null;
}

export class TaxZoneDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'us-ca' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['LINE', 'TOTAL'] }) rounding: string;
  @ApiProperty({ type: [TaxZoneRegionDto] }) regions: TaxZoneRegionDto[];
}

export class CreateTaxZoneDto {
  @ApiProperty({ example: 'us-ca' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'California' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({ enum: ['LINE', 'TOTAL'], default: 'LINE' })
  @IsOptional()
  @IsIn(['LINE', 'TOTAL'])
  rounding?: 'LINE' | 'TOTAL';
  @ApiProperty({ type: [TaxZoneRegionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TaxZoneRegionDto)
  regions: TaxZoneRegionDto[];
}

export class UpdateTaxZoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ enum: ['LINE', 'TOTAL'] })
  @IsOptional()
  @IsIn(['LINE', 'TOTAL'])
  rounding?: 'LINE' | 'TOTAL';
  @ApiPropertyOptional({
    type: [TaxZoneRegionDto],
    description: 'Replaces the regions',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TaxZoneRegionDto)
  regions?: TaxZoneRegionDto[];
}

export class TaxRateDto {
  @ApiProperty() id: string;
  @ApiProperty() zoneId: string;
  @ApiProperty() productTaxClassId: string;
  @ApiProperty({ nullable: true, type: String }) customerTaxClassId:
    string | null;
  @ApiProperty({ example: 'CA state tax' }) name: string;
  @ApiProperty({ example: '7.2500' }) rate: string;
  @ApiProperty() priority: number;
  @ApiProperty() isCompound: boolean;
  @ApiProperty({ example: '2026-01-01' }) validFrom: string;
  @ApiProperty({ nullable: true, type: String }) validTo: string | null;
}

export class CreateTaxRateDto {
  @ApiProperty() @IsUUID() zoneId: string;
  @ApiProperty() @IsUUID() productTaxClassId: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Omit for every customer class',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  customerTaxClassId?: string | null;
  @ApiProperty({ example: 'VAT' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  name: string;
  @ApiProperty({ example: '19', description: 'Percent, up to 4 decimals' })
  @Matches(PERCENT_PATTERN, {
    message: 'rate must be a percent between 0 and 100 with up to 4 decimals',
  })
  rate: string;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isCompound?: boolean;
  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString({ strict: true })
  validFrom?: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString({ strict: true })
  validTo?: string | null;
}

/** Rates are effective-dated: change one by ending it (`validTo`) and adding a new one. */
export class UpdateTaxRateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) priority?: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString({ strict: true })
  validTo?: string | null;
}

export class TaxDestinationDto {
  @ApiProperty({ example: 'US' }) @Matches(COUNTRY_PATTERN) countryCode: string;
  @ApiPropertyOptional({ example: 'CA' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  regionCode?: string;
  @ApiPropertyOptional({ example: '90012' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postcode?: string;
}

export class TaxLineInputDto {
  @ApiProperty({ example: 'line-1' }) @IsString() @MaxLength(64) key: string;
  @ApiProperty({
    example: 10000,
    description: 'Minor units (unit price × qty)',
  })
  @IsInt()
  @Min(0)
  amount: number;
  @ApiPropertyOptional({ example: 'standard', default: 'standard' })
  @IsOptional()
  @Matches(CODE_PATTERN)
  productTaxClass?: string;
}

export class CalculateTaxDto {
  @ApiProperty({ type: TaxDestinationDto })
  @ValidateNested()
  @Type(() => TaxDestinationDto)
  destination: TaxDestinationDto;
  @ApiPropertyOptional({ example: 'retail', default: 'retail' })
  @IsOptional()
  @Matches(CODE_PATTERN)
  customerTaxClass?: string;
  @ApiProperty() @IsBoolean() pricesIncludeTax: boolean;
  @ApiPropertyOptional({ example: '2026-10-17' })
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;
  @ApiProperty({ type: [TaxLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TaxLineInputDto)
  lines: TaxLineInputDto[];
}

export class AppliedTaxDto {
  @ApiProperty() rateId: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: '7.2500' }) rate: string;
  @ApiProperty() amount: number;
}

export class TaxLineResultDto {
  @ApiProperty() key: string;
  @ApiProperty() net: number;
  @ApiProperty() tax: number;
  @ApiProperty() gross: number;
  @ApiProperty({ type: [AppliedTaxDto] }) taxes: AppliedTaxDto[];
}

export class TaxResultDto {
  @ApiProperty({ type: [TaxLineResultDto] }) lines: TaxLineResultDto[];
  @ApiProperty({
    type: 'object',
    required: ['net', 'tax', 'gross'],
    properties: {
      net: { type: 'number' },
      tax: { type: 'number' },
      gross: { type: 'number' },
    },
  })
  totals: { net: number; tax: number; gross: number };
  @ApiProperty({ type: [AppliedTaxDto] }) taxes: AppliedTaxDto[];
  @ApiProperty({ type: [String] }) zones: string[];
  @ApiProperty({ enum: ['LINE', 'TOTAL'] }) rounding: string;
}
