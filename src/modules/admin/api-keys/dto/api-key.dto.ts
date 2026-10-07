import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'ERP sync' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @ApiProperty({
    type: [String],
    example: ['catalog:read', 'inventory:write'],
    description: 'Must be a subset of your own permissions',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions: string[];

  @ApiPropertyOptional({ description: 'ISO date-time; omit for no expiry' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ApiKeyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({
    example: 'aB3dE5fG',
    description: 'Identifies the key; shown as shk_<prefix>_…',
  })
  prefix: string;
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiPropertyOptional({ nullable: true, type: String }) createdBy:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) lastUsedAt: Date | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) revokedAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class ApiKeyCreatedDto extends ApiKeyDto {
  @ApiProperty({
    description:
      'The full key — shown ONCE. Send it as the `x-api-key` header.',
  })
  key: string;
}
