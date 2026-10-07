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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  LINK_MESSAGE,
  LINK_PATTERN,
  PublishingDto,
  StorefrontMediaDto,
} from '../../../common/content/content.dto.js';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { ListContentQueryDto } from '../../cms/dto/page.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const PLACEMENT_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
export const SLIDER_CODE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

// ─── Banners ───

export class BannerTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  title?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  subtitle?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  ctaLabel?: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Locale-specific artwork; falls back to the banner image',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  imageId?: string | null;
}

export class CreateBannerDto {
  @ApiProperty({
    example: 'home.hero',
    description: 'Where the frontend shows it',
  })
  @MaxLength(64)
  @Matches(PLACEMENT_PATTERN)
  placement: string;
  @ApiProperty({ example: 'Summer sale hero' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Omit for every store',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ nullable: true, type: String, example: '/sale' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `linkUrl ${LINK_MESSAGE}` })
  linkUrl?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  imageId?: string | null;
  @ApiPropertyOptional({ type: [BannerTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BannerTranslationDto)
  translations?: BannerTranslationDto[];
}

export class UpdateBannerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(64)
  @Matches(PLACEMENT_PATTERN)
  placement?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `linkUrl ${LINK_MESSAGE}` })
  linkUrl?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  imageId?: string | null;
  @ApiPropertyOptional({
    type: [BannerTranslationDto],
    description: 'Upserted by locale',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BannerTranslationDto)
  translations?: BannerTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class BannerTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty({ nullable: true, type: String }) subtitle: string | null;
  @ApiProperty({ nullable: true, type: String }) ctaLabel: string | null;
  @ApiProperty({ nullable: true, type: String }) imageId: string | null;
}

export class BannerDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty() placement: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ nullable: true, type: String }) linkUrl: string | null;
  @ApiProperty({ nullable: true, type: String }) imageId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [BannerTranslationViewDto] })
  translations: BannerTranslationViewDto[];
}

export class ListBannersQueryDto extends ListContentQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(64)
  @Matches(PLACEMENT_PATTERN)
  placement?: string;
}

export class BannerListDto {
  @ApiProperty({ type: [BannerDto] }) data: BannerDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

// ─── Sliders ───

export class SlideTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  title?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  caption?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  ctaLabel?: string;
}

export class CreateSliderDto {
  @ApiProperty({ example: 'home' })
  @MaxLength(64)
  @Matches(SLIDER_CODE_PATTERN)
  code: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1000,
    maximum: 60000,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1000)
  @Max(60_000)
  autoplayMs?: number | null;
}

export class UpdateSliderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1000)
  @Max(60_000)
  autoplayMs?: number | null;
}

export class CreateSlideDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  imageId?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `linkUrl ${LINK_MESSAGE}` })
  linkUrl?: string | null;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({ type: [SlideTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SlideTranslationDto)
  translations?: SlideTranslationDto[];
}

/** Same fields as a new slide, all optional and without defaults: omitted means unchanged. */
export class UpdateSlideDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  imageId?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `linkUrl ${LINK_MESSAGE}` })
  linkUrl?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({ type: [SlideTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SlideTranslationDto)
  translations?: SlideTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class SlideTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty({ nullable: true, type: String }) caption: string | null;
  @ApiProperty({ nullable: true, type: String }) ctaLabel: string | null;
}

export class SlideDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) imageId: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ nullable: true, type: String }) linkUrl: string | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [SlideTranslationViewDto] })
  translations: SlideTranslationViewDto[];
}

export class SliderDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty({ nullable: true, type: Number }) autoplayMs: number | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [SlideDto] }) slides: SlideDto[];
}

export class SliderListDto {
  @ApiProperty({ type: [SliderDto] }) data: SliderDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

// ─── Storefront ───

export class StorefrontBannersQueryDto {
  @ApiProperty({ example: 'home.hero' })
  @MaxLength(64)
  @Matches(PLACEMENT_PATTERN)
  placement: string;
}

export class StorefrontBannerDto {
  @ApiProperty() id: string;
  @ApiProperty() placement: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty({ nullable: true, type: String }) subtitle: string | null;
  @ApiProperty({ nullable: true, type: String }) ctaLabel: string | null;
  @ApiProperty({ nullable: true, type: String }) linkUrl: string | null;
  @ApiProperty({ nullable: true, type: StorefrontMediaDto })
  image: StorefrontMediaDto | null;
}

export class StorefrontSlideDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty({ nullable: true, type: String }) caption: string | null;
  @ApiProperty({ nullable: true, type: String }) ctaLabel: string | null;
  @ApiProperty({ nullable: true, type: String }) linkUrl: string | null;
  @ApiProperty({ nullable: true, type: StorefrontMediaDto })
  image: StorefrontMediaDto | null;
}

export class StorefrontSliderDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ nullable: true, type: Number }) autoplayMs: number | null;
  @ApiProperty({ type: [StorefrontSlideDto] }) slides: StorefrontSlideDto[];
}
