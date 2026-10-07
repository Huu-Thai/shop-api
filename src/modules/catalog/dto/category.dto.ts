import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CategoryTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'T-Shirts' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    example: 't-shirts',
    description: 'Derived from the name when omitted',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(65_535)
  description?: string;
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

export class CreateCategoryDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Omit for a root category',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includeInMenu?: boolean;
  @ApiProperty({ type: [CategoryTranslationDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CategoryTranslationDto)
  translations: CategoryTranslationDto[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Websites that show the category',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  websiteIds?: string[];
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeInMenu?: boolean;
  @ApiPropertyOptional({
    type: [CategoryTranslationDto],
    description: 'Upserted by locale',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CategoryTranslationDto)
  translations?: CategoryTranslationDto[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Locales whose translation is removed',
  })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the website assignment',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  websiteIds?: string[];
}

export class MoveCategoryDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'New parent; null moves to the root',
  })
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId: string | null;
  @ApiPropertyOptional({
    description:
      'Index among the new siblings (0 = first); siblings are renumbered. Omit to keep the position value.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class CategoryTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String }) metaDescription: string | null;
}

export class CategoryDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) parentId: string | null;
  @ApiProperty() path: string;
  @ApiProperty() level: number;
  @ApiProperty() position: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() includeInMenu: boolean;
  @ApiProperty({ type: [CategoryTranslationViewDto] })
  translations: CategoryTranslationViewDto[];
  @ApiProperty({ type: [String] }) websiteIds: string[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CategoryNodeDto extends CategoryDto {
  @ApiProperty({ type: () => [CategoryNodeDto] }) children: CategoryNodeDto[];
}
