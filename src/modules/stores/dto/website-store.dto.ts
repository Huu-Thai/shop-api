import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  CODE_MESSAGE,
  CODE_PATTERN,
  COUNTRY_PATTERN,
  CURRENCY_PATTERN,
  LOCALE_PATTERN,
} from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Origin only: scheme + host (+ port), no trailing slash. */
const origin = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\/+$/, '') : value;

export class WebsiteDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'vn' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'VND' }) baseCurrencyCode: string;
  @ApiProperty({ nullable: true, type: String }) defaultStoreId: string | null;
  @ApiProperty() position: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [String], description: 'Store codes' }) stores: string[];
}

export class CreateWebsiteDto {
  @ApiProperty({ example: 'vn' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'Shop Vietnam' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({ example: 'VND' })
  @Matches(CURRENCY_PATTERN)
  baseCurrencyCode: string;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWebsiteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CURRENCY_PATTERN)
  baseCurrencyCode?: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Must be one of the website’s stores',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  defaultStoreId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class StoreDto {
  @ApiProperty() id: string;
  @ApiProperty() websiteId: string;
  @ApiProperty({ example: 'vn-vi' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'https://shop.example.vn',
  })
  baseUrl: string | null;
  @ApiProperty({ example: 'vi-VN' }) defaultLocaleCode: string;
  @ApiProperty({ type: [String], example: ['vi-VN', 'en-US'] })
  localeCodes: string[];
  @ApiProperty({ example: 'VND' }) defaultCurrencyCode: string;
  @ApiProperty({ type: [String], example: ['VND', 'USD'] })
  currencyCodes: string[];
  @ApiProperty({ example: 'VN' }) countryCode: string;
  @ApiProperty() pricesIncludeTax: boolean;
  @ApiProperty() position: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateStoreDto {
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ example: 'vn-vi' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'Vietnam — Tiếng Việt' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    example: 'https://shop.example.vn',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(255)
  @Transform(origin)
  baseUrl?: string | null;
  @ApiProperty({ example: 'vi-VN' })
  @Matches(LOCALE_PATTERN)
  defaultLocaleCode: string;
  @ApiPropertyOptional({
    type: [String],
    description: 'Additional locales (the default is always enabled)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(LOCALE_PATTERN, { each: true })
  localeCodes?: string[];
  @ApiProperty({ example: 'VND' })
  @Matches(CURRENCY_PATTERN)
  defaultCurrencyCode: string;
  @ApiPropertyOptional({
    type: [String],
    description:
      'Additional display currencies (the default is always enabled)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(CURRENCY_PATTERN, { each: true })
  currencyCodes?: string[];
  @ApiProperty({ example: 'VN' })
  @Matches(COUNTRY_PATTERN, {
    message: 'countryCode must be ISO 3166-1 alpha-2',
  })
  countryCode: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** The website of a store is fixed (its catalog assignment depends on it). */
export class UpdateStoreDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(255)
  @Transform(origin)
  baseUrl?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  defaultLocaleCode?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(LOCALE_PATTERN, { each: true })
  localeCodes?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CURRENCY_PATTERN)
  defaultCurrencyCode?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(CURRENCY_PATTERN, { each: true })
  currencyCodes?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(COUNTRY_PATTERN)
  countryCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pricesIncludeTax?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
