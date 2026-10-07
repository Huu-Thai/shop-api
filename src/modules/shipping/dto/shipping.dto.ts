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
import { COUNTRY_PATTERN, LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { ShippingRateType } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ShippingNameDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Standard (3–5 days)' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateShippingMethodDto {
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ example: 'standard' })
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/)
  code: string;
  @ApiProperty({ example: 'ups' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  carrier: string;
  @ApiPropertyOptional({
    enum: ShippingRateType,
    enumName: 'ShippingRateType',
    default: 'FLAT',
  })
  @IsOptional()
  @IsEnum(ShippingRateType)
  rateType?: ShippingRateType;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { USD: 799 },
    description: 'Minor units per currency',
  })
  @IsObject()
  amounts: Record<string, number>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { USD: 5000 },
    nullable: true,
    description: 'Free from this discounted subtotal',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  freeOver?: Record<string, number> | null;
  @ApiPropertyOptional({
    type: [String],
    description: 'Destination countries (empty = all)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @Matches(COUNTRY_PATTERN, { each: true })
  countryCodes?: string[];
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Product tax class of the charge',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiProperty({ type: [ShippingNameDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ShippingNameDto)
  translations: ShippingNameDto[];
}

export class UpdateShippingMethodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  carrier?: string;
  @ApiPropertyOptional({ enum: ShippingRateType, enumName: 'ShippingRateType' })
  @IsOptional()
  @IsEnum(ShippingRateType)
  rateType?: ShippingRateType;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Minor units per currency',
  })
  @IsOptional()
  @IsObject()
  amounts?: Record<string, number>;
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Minor units by currency code',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  freeOver?: Record<string, number> | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(COUNTRY_PATTERN, { each: true })
  countryCodes?: string[];
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({
    type: [ShippingNameDto],
    description: 'Upserted by locale',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShippingNameDto)
  translations?: ShippingNameDto[];
}

export class ShippingMethodDto {
  @ApiProperty() id: string;
  @ApiProperty() websiteId: string;
  @ApiProperty() code: string;
  @ApiProperty() carrier: string;
  @ApiProperty({ enum: ShippingRateType, enumName: 'ShippingRateType' })
  rateType: ShippingRateType;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  amounts: Record<string, number>;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  freeOver: Record<string, number> | null;
  @ApiProperty({ type: [String] }) countryCodes: string[];
  @ApiProperty({ nullable: true, type: String }) taxClassId: string | null;
  @ApiProperty() position: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [ShippingNameDto] }) translations: ShippingNameDto[];
}
