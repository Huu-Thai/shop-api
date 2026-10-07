import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  BundleInputType,
  ProductRelationType,
  ProductStatus,
  ProductType,
  ProductVisibility,
} from '../../../database/generated/prisma/enums.js';

export class ProductTranslationDto {
  @ApiProperty() localeCode: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String }) shortDescription:
    string | null;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String }) metaDescription: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  attributes: Record<string, unknown>;
}

export class VariantDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  optionValues: Record<string, string>;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' })
  status: ProductStatus;
  @ApiProperty({ nullable: true, type: Number }) weightGrams: number | null;
  @ApiProperty() position: number;
}

export class BundleSelectionDto {
  @ApiProperty() id: string;
  @ApiProperty() variantId: string;
  @ApiProperty() variantSku: string;
  @ApiProperty() qty: number;
  @ApiProperty() canChangeQty: boolean;
  @ApiProperty() isDefault: boolean;
  @ApiProperty() position: number;
}

export class BundleOptionDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: BundleInputType, enumName: 'BundleInputType' })
  inputType: BundleInputType;
  @ApiProperty() isRequired: boolean;
  @ApiProperty() position: number;
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      required: ['localeCode', 'title'],
      properties: { localeCode: { type: 'string' }, title: { type: 'string' } },
    },
  })
  titles: { localeCode: string; title: string }[];
  @ApiProperty({ type: [BundleSelectionDto] }) selections: BundleSelectionDto[];
}

export class StoreOverrideDto {
  @ApiProperty() storeId: string;
  @ApiProperty({
    enum: ProductStatus,
    enumName: 'ProductStatus',
    nullable: true,
  })
  status: ProductStatus | null;
  @ApiProperty({
    enum: ProductVisibility,
    enumName: 'ProductVisibility',
    nullable: true,
  })
  visibility: ProductVisibility | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  attributes: Record<string, unknown>;
}

export class ProductRelationsDto {
  @ApiProperty({ type: [String] }) related: string[];
  @ApiProperty({ type: [String] }) upsell: string[];
  @ApiProperty({ type: [String] }) crossSell: string[];
}

export class ProductDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  type: ProductType;
  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' })
  status: ProductStatus;
  @ApiProperty({ enum: ProductVisibility, enumName: 'ProductVisibility' })
  visibility: ProductVisibility;
  @ApiProperty() attributeSetId: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  attributes: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true })
  typeOptions: Record<string, unknown>;
  @ApiProperty({ nullable: true, type: Number }) weightGrams: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'null = standard' })
  taxClassId: string | null;
  @ApiProperty({ type: [ProductTranslationDto] })
  translations: ProductTranslationDto[];
  @ApiProperty({ type: [String] }) websiteIds: string[];
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      required: ['categoryId', 'position'],
      properties: {
        categoryId: { type: 'string' },
        position: { type: 'integer' },
      },
    },
  })
  categories: { categoryId: string; position: number }[];
  @ApiProperty({ type: [String] }) configurableAttributes: string[];
  @ApiProperty({ type: [VariantDto] }) variants: VariantDto[];
  @ApiProperty({ type: [BundleOptionDto] }) bundleOptions: BundleOptionDto[];
  @ApiProperty({ type: [StoreOverrideDto] }) storeOverrides: StoreOverrideDto[];
  @ApiProperty({ type: ProductRelationsDto }) relations: ProductRelationsDto;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ nullable: true, type: Date }) deletedAt: Date | null;
}

export class ProductListItemDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  type: ProductType;
  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' })
  status: ProductStatus;
  @ApiProperty({ enum: ProductVisibility, enumName: 'ProductVisibility' })
  visibility: ProductVisibility;
  @ApiProperty({ nullable: true, type: String }) name: string | null;
  @ApiProperty() variantCount: number;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ nullable: true, type: Date }) deletedAt: Date | null;
}

export class ProductListDto {
  @ApiProperty({ type: [ProductListItemDto] }) data: ProductListItemDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'SKU or name contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ enum: ProductType, enumName: 'ProductType' })
  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;
  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() websiteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() attributeSetId?: string;
  @ApiPropertyOptional({
    type: [String],
    description: 'Only these products (comma-separated ids, at most 100)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids?: string[];
  @ApiPropertyOptional({
    description: 'Locale of the returned name',
    example: 'en-US',
  })
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  locale?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeDeleted?: boolean;
  @ApiPropertyOptional({
    enum: ['updatedAt', 'sku', 'createdAt'],
    default: 'updatedAt',
  })
  @IsOptional()
  @IsIn(['updatedAt', 'sku', 'createdAt'])
  sort?: 'updatedAt' | 'sku' | 'createdAt';
}

export const RELATION_KEYS = {
  RELATED: 'related',
  UPSELL: 'upsell',
  CROSSSELL: 'crossSell',
} as const satisfies Record<ProductRelationType, keyof ProductRelationsDto>;

export class SearchVariantsQueryDto {
  @ApiPropertyOptional({
    description: 'SKU, product SKU or product name contains',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({
    description:
      'Only variants that can be sold inside a bundle (simple, virtual, configurable)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  bundleable?: boolean;
  @ApiPropertyOptional({
    description: 'Product name language',
    example: 'en-US',
  })
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  locale?: string;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class VariantSearchItemDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' })
  status: ProductStatus;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  optionValues: Record<string, string>;
  @ApiProperty() productId: string;
  @ApiProperty() productSku: string;
  @ApiProperty({ nullable: true, type: String }) productName: string | null;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  productType: ProductType;
}
