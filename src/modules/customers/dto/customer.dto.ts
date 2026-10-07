import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { CustomerStatus } from '../../../database/generated/prisma/enums.js';
import { AddressDto } from './address.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateCustomerDto {
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ example: 'ann@example.com' })
  @IsEmail()
  @MaxLength(254)
  @Transform(trimLower)
  email: string;
  @ApiProperty({ description: 'Initial password (same policy as sign-up)' })
  @IsString()
  @MaxLength(256)
  password: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName: string;
  @ApiPropertyOptional({
    description: 'Customer group code; default `general`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[+0-9 ()-]{4,32}$/)
  phone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptsMarketing?: boolean;
}

export class UpdateCustomerDto {
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
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Matches(/^[+0-9 ()-]{4,32}$/)
  phone?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptsMarketing?: boolean;
  @ApiPropertyOptional({
    description: 'Move to another customer group (prices, promotions)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupCode?: string;
  @ApiPropertyOptional({
    enum: CustomerStatus,
    enumName: 'CustomerStatus',
    description: 'DISABLED ends every session',
  })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}

export class CustomerDto {
  @ApiProperty() id: string;
  @ApiProperty() websiteId: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
  @ApiProperty({ nullable: true, type: String }) localeCode: string | null;
  @ApiProperty() groupCode: string;
  @ApiProperty({ enum: CustomerStatus, enumName: 'CustomerStatus' })
  status: CustomerStatus;
  @ApiProperty() acceptsMarketing: boolean;
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) lockedUntil: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CustomerDetailDto extends CustomerDto {
  @ApiProperty({ type: [AddressDto] }) addresses: AddressDto[];
}

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() websiteId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupCode?: string;
  @ApiPropertyOptional({ enum: CustomerStatus, enumName: 'CustomerStatus' })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
  @ApiPropertyOptional({ description: 'E-mail or name contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CustomerListDto {
  @ApiProperty({ type: [CustomerDto] }) data: CustomerDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
