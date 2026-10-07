import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PageMetaDto,
  PaginationQueryDto,
} from '../../../../common/dto/pagination.dto.js';
import { AdminUserStatus } from '../../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAdminUserDto {
  @ApiProperty({ example: 'ana@shop.local' })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiProperty({
    description: 'Initial password (≥ 12 chars, 3 character classes)',
  })
  @IsString()
  @MaxLength(256)
  password: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  firstName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  lastName?: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  roleIds: string[];
}

export class UpdateAdminUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  firstName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  lastName?: string;
  @ApiPropertyOptional({ enum: AdminUserStatus })
  @IsOptional()
  @IsEnum(AdminUserStatus)
  status?: AdminUserStatus;
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Replaces the role set',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  roleIds?: string[];
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'New password; all of the user’s sessions end' })
  @IsString()
  @MaxLength(256)
  newPassword: string;
}

export class ListAdminUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'E-mail or name contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ enum: AdminUserStatus })
  @IsOptional()
  @IsEnum(AdminUserStatus)
  status?: AdminUserStatus;
}

export class AdminUserRoleRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
}

export class AdminUserDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) firstName: string | null;
  @ApiProperty({ nullable: true, type: String }) lastName: string | null;
  @ApiProperty({ enum: AdminUserStatus }) status: AdminUserStatus;
  @ApiProperty({ type: [AdminUserRoleRefDto] }) roles: AdminUserRoleRefDto[];
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt: Date | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Set while temporarily locked after failed logins',
  })
  lockedUntil: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class AdminUserPageDto extends PageMetaDto {
  @ApiProperty({ type: [AdminUserDto] }) data: AdminUserDto[];
}
