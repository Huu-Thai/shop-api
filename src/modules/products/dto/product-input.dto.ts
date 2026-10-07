import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
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
import {
  CODE_MESSAGE,
  CODE_PATTERN,
  LOCALE_PATTERN,
} from '../../../common/dto/codes.js';
import {
  BundleInputType,
  ProductStatus,
  ProductType,
  ProductVisibility,
} from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;
const SKU_MESSAGE = 'sku must be 1–64 letters, digits, ".", "_", "-" or "/"';

export class ProductTranslationInputDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Classic Tee' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    example: 'classic-tee',
    description:
      'URL key; derived from the name when omitted. Unique per locale.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  shortDescription?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
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
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Values of localizable attributes',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class ProductCategoryInputDto {
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiPropertyOptional({
    default: 0,
    description: 'Sort order inside the category',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class VariantInputDto {
  @ApiProperty({ example: 'TEE-RED-M' })
  @Matches(SKU_PATTERN, { message: SKU_MESSAGE })
  sku: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { color: 'red', size: 'm' },
  })
  @IsObject()
  options: Record<string, string>;
  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(SKU_PATTERN, { message: SKU_MESSAGE })
  sku?: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  options?: Record<string, string>;
  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  weightGrams?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

export class BundleTitleDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Choose a top' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  title: string;
}

export class BundleSelectionInputDto {
  @ApiProperty({
    description: 'A variant of a simple, virtual or configurable product',
  })
  @IsUUID()
  variantId: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  canChangeQty?: boolean;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

export class BundleOptionInputDto {
  @ApiProperty({ example: 'top' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ enum: BundleInputType, enumName: 'BundleInputType' })
  @IsEnum(BundleInputType)
  inputType: BundleInputType;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiProperty({ type: [BundleTitleDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BundleTitleDto)
  titles: BundleTitleDto[];
  @ApiProperty({ type: [BundleSelectionInputDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BundleSelectionInputDto)
  selections: BundleSelectionInputDto[];
}

export class SetBundleOptionsDto {
  @ApiProperty({
    type: [BundleOptionInputDto],
    description: 'Replaces every option of the bundle',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BundleOptionInputDto)
  options: BundleOptionInputDto[];
}

export class CreateProductDto {
  @ApiProperty({ example: 'TEE-CLASSIC' })
  @Matches(SKU_PATTERN, { message: SKU_MESSAGE })
  sku: string;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  @IsEnum(ProductType)
  type: ProductType;
  @ApiPropertyOptional({
    description: 'Defaults to the "default" attribute set',
  })
  @IsOptional()
  @IsUUID()
  attributeSetId?: string;
  @ApiPropertyOptional({
    enum: ProductStatus,
    enumName: 'ProductStatus',
    default: 'ENABLED',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
  @ApiPropertyOptional({
    enum: ProductVisibility,
    enumName: 'ProductVisibility',
    default: 'CATALOG_SEARCH',
  })
  @IsOptional()
  @IsEnum(ProductVisibility)
  visibility?: ProductVisibility;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { material: 'Cotton' },
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'BUNDLE: priceType, shipmentType · GIFT_CARD: cardType, amounts, allowOpenAmount, openAmountMin/Max, lifetimeDays',
  })
  @IsOptional()
  @IsObject()
  typeOptions?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Product tax class; omit for "standard"',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
  @ApiProperty({ type: [ProductTranslationInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductTranslationInputDto)
  translations: ProductTranslationInputDto[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Websites that sell the product',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  websiteIds?: string[];
  @ApiPropertyOptional({ type: [ProductCategoryInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProductCategoryInputDto)
  categories?: ProductCategoryInputDto[];
  @ApiPropertyOptional({
    type: [String],
    example: ['color', 'size'],
    description: 'CONFIGURABLE: attribute codes that define the variants',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  configurableAttributes?: string[];
  @ApiPropertyOptional({
    type: [VariantInputDto],
    description: 'CONFIGURABLE: initial variants',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VariantInputDto)
  variants?: VariantInputDto[];
  @ApiPropertyOptional({
    type: [BundleOptionInputDto],
    description: 'BUNDLE: options and their selections',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BundleOptionInputDto)
  bundleOptions?: BundleOptionInputDto[];
}

/** `type` and the configurable axes are fixed after creation. */
export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(SKU_PATTERN, { message: SKU_MESSAGE })
  sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() attributeSetId?: string;
  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
  @ApiPropertyOptional({
    enum: ProductVisibility,
    enumName: 'ProductVisibility',
  })
  @IsOptional()
  @IsEnum(ProductVisibility)
  visibility?: ProductVisibility;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Merge patch: null removes a value',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Replaces the type options',
  })
  @IsOptional()
  @IsObject()
  typeOptions?: Record<string, unknown>;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  weightGrams?: number | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Product tax class; null = "standard"',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
  @ApiPropertyOptional({
    type: [ProductTranslationInputDto],
    description:
      'Upserted by locale (translation attributes are merge-patched)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductTranslationInputDto)
  translations?: ProductTranslationInputDto[];
  @ApiPropertyOptional({ type: [String] })
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
  @ApiPropertyOptional({
    type: [ProductCategoryInputDto],
    description: 'Replaces the category assignment',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProductCategoryInputDto)
  categories?: ProductCategoryInputDto[];
}

export class StoreOverrideInputDto {
  @ApiPropertyOptional({
    enum: ProductStatus,
    enumName: 'ProductStatus',
    nullable: true,
    description: 'null = inherit',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEnum(ProductStatus)
  status?: ProductStatus | null;
  @ApiPropertyOptional({
    enum: ProductVisibility,
    enumName: 'ProductVisibility',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEnum(ProductVisibility)
  visibility?: ProductVisibility | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Replaces the attribute patch for this store',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class SetRelationsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  related?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  upsell?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  crossSell?: string[];
}
