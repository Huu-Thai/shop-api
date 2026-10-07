import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PublishingDto } from '../../../common/content/content.dto.js';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { ContentStatus } from '../../../database/generated/prisma/enums.js';
import { Trim } from './common.js';

export class PageTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Shipping & returns' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Trim()
  title: string;
  @ApiPropertyOptional({
    example: 'help/shipping',
    description:
      'URL path (segments allowed); derived from the title when omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;
  @ApiPropertyOptional({
    description:
      'HTML (sanitized on save). `{{block id="identifier"}}` embeds a block.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1_000_000)
  content?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  metaTitle?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  metaDescription?: string;
}

export class CreatePageDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Store that shows the page; omit for every store (a store page with the same slug wins)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiPropertyOptional({ example: 'default', description: 'Frontend layout' })
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  layout?: string;
  @ApiProperty({ type: [PageTranslationDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PageTranslationDto)
  translations: PageTranslationDto[];
}

export class UpdatePageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  layout?: string;
  @ApiPropertyOptional({
    type: [PageTranslationDto],
    description: 'Upserted by locale',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PageTranslationDto)
  translations?: PageTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class PageTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty() content: string;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String })
  metaDescription: string | null;
}

export class PageDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty() layout: string;
  @ApiProperty({ nullable: true, type: String }) createdById: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [PageTranslationViewDto] })
  translations: PageTranslationViewDto[];
}

export class ListContentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Store id, or "global" for content shown in every store',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== 'global')
  @IsUUID()
  storeId?: string;
  @ApiPropertyOptional({ enum: ContentStatus, enumName: 'ContentStatus' })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
  @ApiPropertyOptional({ description: 'Title, slug or identifier contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class PageListDto {
  @ApiProperty({ type: [PageDto] }) data: PageDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
