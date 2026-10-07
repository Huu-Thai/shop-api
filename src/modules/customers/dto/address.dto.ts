import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { COUNTRY_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateAddressDto {
  @ApiProperty({ example: 'Ann' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName: string;
  @ApiProperty({ example: 'Lee' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;
  @ApiPropertyOptional({ example: '+1 555 0100' })
  @IsOptional()
  @Matches(/^[+0-9 ()-]{4,32}$/, { message: 'phone has invalid characters' })
  phone?: string;
  @ApiProperty({ example: 'US' })
  @Transform(upper)
  @Matches(COUNTRY_PATTERN)
  countryCode: string;
  @ApiPropertyOptional({ example: 'CA', description: 'State / province code' })
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z0-9-]{1,16}$/)
  regionCode?: string;
  @ApiProperty({ example: 'Los Angeles' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  city: string;
  @ApiPropertyOptional({ example: '90001' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  postcode?: string;
  @ApiProperty({ example: '1 Main St' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  line1: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  line2?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefaultShipping?: boolean;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefaultBilling?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[+0-9 ()-]{4,32}$/, { message: 'phone has invalid characters' })
  phone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(upper)
  @Matches(COUNTRY_PATTERN)
  countryCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z0-9-]{1,16}$/)
  regionCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  city?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  postcode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  line1?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  line2?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefaultShipping?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefaultBilling?: boolean;
}

export class AddressDto {
  @ApiProperty() id: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ nullable: true, type: String }) company: string | null;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
  @ApiProperty() countryCode: string;
  @ApiProperty({ nullable: true, type: String }) regionCode: string | null;
  @ApiProperty() city: string;
  @ApiProperty({ nullable: true, type: String }) postcode: string | null;
  @ApiProperty() line1: string;
  @ApiProperty({ nullable: true, type: String }) line2: string | null;
  @ApiProperty() isDefaultShipping: boolean;
  @ApiProperty() isDefaultBilling: boolean;
}
