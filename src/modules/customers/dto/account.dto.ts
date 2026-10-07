import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'ann@example.com' })
  @IsEmail()
  @MaxLength(254)
  @Transform(trimLower)
  email: string;
  @ApiProperty({
    description: '≥ 12 characters, at least 3 of: lower, upper, digit, symbol',
  })
  @IsString()
  @MaxLength(256)
  password: string;
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
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  acceptsMarketing?: boolean;
}

export class CustomerLoginDto {
  @ApiProperty({ example: 'ann@example.com' })
  @IsEmail()
  @MaxLength(254)
  @Transform(trimLower)
  email: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}

export class CustomerRefreshDto {
  @ApiProperty({
    description: 'Refresh token from login or the last refresh (single use)',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken: string;
}

export class CustomerLogoutDto {
  @ApiPropertyOptional({
    default: false,
    description: 'End every session of the account',
  })
  @IsOptional()
  @IsBoolean()
  everywhere?: boolean;
}

export class CustomerChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(256) currentPassword: string;
  @ApiProperty() @IsString() @MaxLength(256) newPassword: string;
}

export class CustomerTokenPairDto {
  @ApiProperty({ example: 'Bearer' }) tokenType: 'Bearer';
  @ApiProperty({
    description: 'JWT for `Authorization: Bearer …` on storefront requests',
  })
  accessToken: string;
  @ApiProperty({ example: 900 }) expiresIn: number;
  @ApiProperty({
    description: 'Single-use; exchange at POST /store/account/refresh',
  })
  refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: Date;
}

export class UpdateProfileDto {
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
  @Matches(/^[+0-9 ()-]{4,32}$/, { message: 'phone has invalid characters' })
  phone?: string | null;
  @ApiPropertyOptional({
    example: 'vi-VN',
    description: 'Preferred locale (e-mails)',
  })
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptsMarketing?: boolean;
}

export class ProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
  @ApiProperty({ nullable: true, type: String }) localeCode: string | null;
  @ApiProperty() acceptsMarketing: boolean;
  @ApiProperty({ example: 'general', description: 'Customer group (prices)' })
  group: string;
  @ApiProperty() createdAt: Date;
}
