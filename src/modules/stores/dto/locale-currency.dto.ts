import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CURRENCY_PATTERN, LOCALE_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class LocaleDto {
  @ApiProperty({ example: 'vi-VN' }) code: string;
  @ApiProperty({ example: 'Tiếng Việt' }) name: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ nullable: true, type: String, example: 'en-US' })
  fallbackCode: string | null;
}

export class CreateLocaleDto {
  @ApiProperty({
    example: 'fr-CA',
    description: 'BCP 47: language[-Script][-REGION]',
  })
  @Matches(LOCALE_PATTERN, { message: 'code must be a BCP 47 tag like en-US' })
  code: string;
  @ApiProperty({ example: 'Français (Canada)' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({ example: 'fr-FR', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(LOCALE_PATTERN)
  fallbackCode?: string | null;
}

export class UpdateLocaleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(LOCALE_PATTERN)
  fallbackCode?: string | null;
}

export class CurrencyDto {
  @ApiProperty({ example: 'VND' }) code: string;
  @ApiProperty({ example: 'Vietnamese Dong' }) name: string;
  @ApiProperty({ example: '₫' }) symbol: string;
  @ApiProperty({
    example: 0,
    description:
      'Digits after the decimal point; amounts are integers in minor units',
  })
  minorUnits: number;
  @ApiProperty() isActive: boolean;
}

export class CreateCurrencyDto {
  @ApiProperty({ example: 'CHF' })
  @Matches(CURRENCY_PATTERN, {
    message: 'code must be an ISO 4217 code like USD',
  })
  code: string;
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(8) symbol: string;
  @ApiProperty({ minimum: 0, maximum: 4 })
  @IsInt()
  @Min(0)
  @Max(4)
  minorUnits: number;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** `minorUnits` is fixed after creation: stored amounts depend on it. */
export class UpdateCurrencyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  symbol?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
