import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @ApiProperty({ example: 'admin@shop.local' })
  @IsEmail()
  @MaxLength(254)
  @Transform(trimLower)
  email: string;

  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}

export class RefreshDto {
  @ApiProperty({
    description:
      'Refresh token from login or the previous refresh (single use)',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(256) currentPassword: string;
  @ApiProperty({
    description: '≥ 12 characters, at least 3 of: lower, upper, digit, symbol',
  })
  @IsString()
  @MaxLength(256)
  newPassword: string;
}

export class TokenPairDto {
  @ApiProperty({ example: 'Bearer' }) tokenType: 'Bearer';
  @ApiProperty({ description: 'JWT for `Authorization: Bearer …`' })
  accessToken: string;
  @ApiProperty({
    example: 900,
    description: 'Seconds until the access token expires',
  })
  expiresIn: number;
  @ApiProperty({
    description:
      'Single-use; exchange at POST /admin/auth/refresh. Rotated on every use.',
  })
  refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: Date;
}

export class MeDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) firstName: string | null;
  @ApiProperty({ nullable: true, type: String }) lastName: string | null;
  @ApiProperty({ type: [String], example: ['super-admin'] }) roles: string[];
  @ApiProperty({ type: [String], example: ['*'] }) permissions: string[];
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt: Date | null;
}
