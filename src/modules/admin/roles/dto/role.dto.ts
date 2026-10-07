import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  @ApiProperty({
    example: 'catalog-manager',
    description: 'lower-case, digits and dashes',
  })
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  code: string;
  @ApiProperty({ example: 'Catalog manager' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  description?: string;
  @ApiProperty({
    type: [String],
    example: ['catalog:*', 'pricing:read'],
    description: 'From GET /admin/permissions; `area:*` and `*` allowed',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions: string[];
}

export class UpdateRoleDto {
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
  @MaxLength(500)
  @Transform(trim)
  description?: string;
  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the permission set',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions?: string[];
}

export class RoleDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ description: 'System roles cannot be changed or deleted' })
  isSystem: boolean;
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiProperty({ description: 'Admin users holding this role' })
  userCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class PermissionDto {
  @ApiProperty({ example: 'catalog:write' }) key: string;
  @ApiProperty({ example: 'catalog' }) area: string;
  @ApiProperty({ example: 'Manage categories, attributes and products' })
  description: string;
}
