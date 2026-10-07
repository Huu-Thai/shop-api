import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
import { Trim } from './common.js';
import { ListContentQueryDto } from './page.dto.js';

export class PostTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Summer lookbook' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Trim()
  title: string;
  @ApiPropertyOptional({ description: 'Derived from the title when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  excerpt?: string;
  @ApiPropertyOptional({ description: 'HTML (sanitized on save)' })
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

export class CreatePostDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  featuredImageId?: string | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  tagIds?: string[];
  @ApiProperty({ type: [PostTranslationDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PostTranslationDto)
  translations: PostTranslationDto[];
}

export class UpdatePostDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  featuredImageId?: string | null;
  @ApiPropertyOptional({ type: [String], description: 'Replaces the tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  tagIds?: string[];
  @ApiPropertyOptional({ type: [PostTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PostTranslationDto)
  translations?: PostTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class PostTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String }) excerpt: string | null;
  @ApiProperty() content: string;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String })
  metaDescription: string | null;
}

export class PostDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty({ nullable: true, type: String }) authorId: string | null;
  @ApiProperty({ nullable: true, type: String })
  featuredImageId: string | null;
  @ApiProperty({ type: [String] }) tagIds: string[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [PostTranslationViewDto] })
  translations: PostTranslationViewDto[];
}

export class ListPostsQueryDto extends ListContentQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() tagId?: string;
}

export class PostListDto {
  @ApiProperty({ type: [PostDto] }) data: PostDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
