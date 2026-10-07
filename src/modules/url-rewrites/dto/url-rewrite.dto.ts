import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { UrlTargetType } from '../../../database/generated/prisma/enums.js';

export class UrlRewriteDto {
  @ApiProperty() id: string;
  @ApiProperty() storeId: string;
  @ApiProperty() localeCode: string;
  @ApiProperty({ example: 'men/t-shirts' }) requestPath: string;
  @ApiProperty({ enum: UrlTargetType, enumName: 'UrlTargetType' })
  targetType: UrlTargetType;
  @ApiProperty({ nullable: true, type: String }) targetId: string | null;
  @ApiProperty({ nullable: true, type: String }) targetPath: string | null;
  @ApiProperty({ nullable: true, type: Number, enum: [301, 302] })
  redirectType: number | null;
  @ApiProperty() isSystem: boolean;
  @ApiProperty() updatedAt: Date;
}

export class UrlRewriteListDto {
  @ApiProperty({ type: [UrlRewriteDto] }) data: UrlRewriteDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListUrlRewritesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
  @ApiPropertyOptional({ enum: UrlTargetType, enumName: 'UrlTargetType' })
  @IsOptional()
  @IsEnum(UrlTargetType)
  targetType?: UrlTargetType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() targetId?: string;
  @ApiPropertyOptional({ description: 'Request path contains' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class CreateRedirectDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: '/summer-sale' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  requestPath: string;
  @ApiProperty({
    example: '/women/dresses',
    description: 'Store path or absolute URL',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  targetPath: string;
  @ApiPropertyOptional({ enum: [301, 302], default: 301 })
  @IsOptional()
  @IsIn([301, 302])
  redirectType?: 301 | 302;
}

export class RebuildUrlRewritesDto {
  @ApiPropertyOptional({
    description: 'One store; omit to rebuild every store',
  })
  @IsOptional()
  @IsUUID()
  storeId?: string;
}

export class UrlResolutionDto {
  @ApiProperty({ enum: UrlTargetType, enumName: 'UrlTargetType' })
  type: UrlTargetType;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Product, category, page or post id',
  })
  id: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Canonical path of the target in this store and locale',
  })
  canonicalPath: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    enum: [301, 302],
    description: 'Redirect the visitor to `location`',
  })
  redirectStatus: number | null;
  @ApiProperty({ nullable: true, type: String }) location: string | null;
}
