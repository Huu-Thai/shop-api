import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  BundleInputType,
  ImageRole,
  ProductType,
  UrlTargetType,
} from '../../../database/generated/prisma/enums.js';

// ─── Shared ───

export class StorefrontRenditionDto {
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty() url: string;
}

export class StorefrontImageDto {
  @ApiProperty() url: string;
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty({ nullable: true, type: String }) alt: string | null;
  @ApiProperty({ enum: ImageRole, enumName: 'ImageRole' }) role: ImageRole;
  @ApiProperty({
    type: [StorefrontRenditionDto],
    description:
      'WebP renditions, smallest first (may be empty right after upload)',
  })
  renditions: StorefrontRenditionDto[];
}

export class StorefrontPriceTierDto {
  @ApiProperty({ example: 10 }) minQty: number;
  @ApiProperty({
    example: 2299,
    description: 'Unit price from this quantity (minor units)',
  })
  amount: number;
  @ApiProperty({ example: '$22.99' }) formatted: string;
}

/** A price as shown in this store: `amount` is gross when the store displays tax-inclusive prices. */
export class StorefrontPriceDto {
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({
    example: 2599,
    description: 'Minor units; gross or net per `includesTax`',
  })
  amount: number;
  @ApiProperty({ example: 2599 }) net: number;
  @ApiProperty({ example: 2599 }) gross: number;
  @ApiProperty({ description: 'The store shows prices including tax' })
  includesTax: boolean;
  @ApiProperty({
    example: '19.0000',
    description:
      'Tax rate for the store’s country (the address may change it at checkout)',
  })
  taxRate: string;
  @ApiProperty({ example: '$25.99' }) formatted: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: '"Was" price (minor units)',
  })
  compareAt: number | null;
  @ApiProperty({ nullable: true, type: String }) compareAtFormatted:
    string | null;
  @ApiProperty({
    type: [StorefrontPriceTierDto],
    description: 'Lower unit prices from a quantity',
  })
  tiers: StorefrontPriceTierDto[];
  @ApiProperty({
    description:
      'Converted from the store currency with the latest exchange rate',
  })
  converted: boolean;
}

export class StorefrontStockDto {
  @ApiProperty({
    description: 'False for goods without stock (virtual, gift cards)',
  })
  managed: boolean;
  @ApiProperty() inStock: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Units available on this website; null when not managed',
  })
  salable: number | null;
}

// ─── Categories ───

export class StorefrontCategoryDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) parentId: string | null;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'men/t-shirts',
    description: 'Canonical path in this store and locale',
  })
  urlPath: string | null;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String }) metaDescription: string | null;
  @ApiProperty() level: number;
  @ApiProperty() position: number;
  @ApiProperty() includeInMenu: boolean;
  @ApiProperty({ type: StorefrontImageDto, nullable: true })
  image: StorefrontImageDto | null;
}

export class StorefrontCategoryNodeDto extends StorefrontCategoryDto {
  @ApiProperty({ type: () => [StorefrontCategoryNodeDto] })
  children: StorefrontCategoryNodeDto[];
}

export class StorefrontBreadcrumbDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) urlPath: string | null;
}

// ─── Products ───

export class StorefrontProductCardDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  type: ProductType;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String, example: 'classic-tee' })
  urlPath: string | null;
  @ApiProperty({ nullable: true, type: String }) shortDescription:
    string | null;
  @ApiProperty({
    type: StorefrontImageDto,
    nullable: true,
    description: 'SMALL, else BASE, else the first image',
  })
  image: StorefrontImageDto | null;
  @ApiProperty({
    type: StorefrontPriceDto,
    nullable: true,
    description: 'Lowest ("from") price; null when not priced in this store',
  })
  price: StorefrontPriceDto | null;
  @ApiProperty() inStock: boolean;
}

export class StorefrontProductListDto {
  @ApiProperty({ type: [StorefrontProductCardDto] })
  data: StorefrontProductCardDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class StorefrontAttributeValueDto {
  @ApiProperty({ example: 'material' }) code: string;
  @ApiProperty({ example: 'Material' }) label: string;
  @ApiProperty({
    description: 'Raw value: string, number, boolean or a list of option codes',
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: { type: 'string' } },
    ],
  })
  value: unknown;
  @ApiProperty({
    example: 'Organic cotton',
    description: 'Display text (option labels joined for multiselects)',
  })
  valueLabel: string;
}

export class StorefrontOptionValueDto {
  @ApiProperty({ example: 'red' }) code: string;
  @ApiProperty({ example: 'Red' }) label: string;
  @ApiProperty({ nullable: true, type: String, example: '#d32f2f' }) swatch:
    string | null;
}

export class StorefrontConfigurableOptionDto {
  @ApiProperty({ example: 'color' }) code: string;
  @ApiProperty({ example: 'Colour' }) label: string;
  @ApiProperty({
    type: [StorefrontOptionValueDto],
    description: 'Only values that some enabled variant has',
  })
  values: StorefrontOptionValueDto[];
}

export class StorefrontVariantDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { color: 'red', size: 'm' },
  })
  options: Record<string, string>;
  @ApiProperty({ type: [StorefrontImageDto] }) images: StorefrontImageDto[];
  @ApiProperty({ type: StorefrontPriceDto, nullable: true })
  price: StorefrontPriceDto | null;
  @ApiProperty({ type: StorefrontStockDto }) stock: StorefrontStockDto;
}

export class StorefrontBundleSelectionDto {
  @ApiProperty() variantId: string;
  @ApiProperty() productId: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() qty: number;
  @ApiProperty() canChangeQty: boolean;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({
    type: StorefrontPriceDto,
    nullable: true,
    description: 'Unit price of the selected item',
  })
  price: StorefrontPriceDto | null;
  @ApiProperty() inStock: boolean;
}

export class StorefrontBundleOptionDto {
  @ApiProperty() code: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: BundleInputType, enumName: 'BundleInputType' })
  inputType: BundleInputType;
  @ApiProperty() isRequired: boolean;
  @ApiProperty({ type: [StorefrontBundleSelectionDto] })
  selections: StorefrontBundleSelectionDto[];
}

export class StorefrontBundleDto {
  @ApiProperty({ enum: ['DYNAMIC', 'FIXED'] }) priceType: 'DYNAMIC' | 'FIXED';
  @ApiProperty({ enum: ['TOGETHER', 'SEPARATELY'] }) shipmentType:
    'TOGETHER' | 'SEPARATELY';
  @ApiProperty({ type: [StorefrontBundleOptionDto] })
  options: StorefrontBundleOptionDto[];
}

export class StorefrontMoneyAmountDto {
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ example: 2500, description: 'Integer minor units' })
  amount: number;
}

export class StorefrontGiftCardDto {
  @ApiProperty({ enum: ['VIRTUAL', 'PHYSICAL'] }) cardType:
    'VIRTUAL' | 'PHYSICAL';
  @ApiProperty({
    type: [StorefrontMoneyAmountDto],
    description: 'Preset amounts in the request currency',
  })
  amounts: StorefrontMoneyAmountDto[];
  @ApiProperty() allowOpenAmount: boolean;
  @ApiProperty({ nullable: true, type: Number }) openAmountMin: number | null;
  @ApiProperty({ nullable: true, type: Number }) openAmountMax: number | null;
  @ApiProperty({ nullable: true, type: Number }) lifetimeDays: number | null;
}

export class StorefrontProductDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty({ enum: ProductType, enumName: 'ProductType' })
  type: ProductType;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String }) urlPath: string | null;
  @ApiProperty({
    example: 'vi-VN',
    description: 'Locale of the returned texts (after fallback)',
  })
  locale: string;
  @ApiProperty({ nullable: true, type: String }) shortDescription:
    string | null;
  @ApiProperty({ nullable: true, type: String, description: 'HTML' })
  description: string | null;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String }) metaDescription: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Shipping weight; null for virtual goods',
  })
  weightGrams: number | null;
  @ApiProperty({ type: [StorefrontAttributeValueDto] })
  attributes: StorefrontAttributeValueDto[];
  @ApiProperty({ type: [StorefrontImageDto] }) images: StorefrontImageDto[];
  @ApiProperty({ type: [StorefrontBreadcrumbDto] })
  breadcrumbs: StorefrontBreadcrumbDto[];
  @ApiProperty({
    type: [StorefrontConfigurableOptionDto],
    description: 'CONFIGURABLE: the option matrix',
  })
  configurableOptions: StorefrontConfigurableOptionDto[];
  @ApiProperty({
    type: [StorefrontVariantDto],
    description: 'Enabled variants (one default for non-configurable types)',
  })
  variants: StorefrontVariantDto[];
  @ApiProperty({ type: StorefrontBundleDto, nullable: true })
  bundle: StorefrontBundleDto | null;
  @ApiProperty({ type: StorefrontGiftCardDto, nullable: true })
  giftCard: StorefrontGiftCardDto | null;
  @ApiProperty({
    type: StorefrontPriceDto,
    nullable: true,
    description:
      'Lowest ("from") price; bundles: cheapest required configuration',
  })
  price: StorefrontPriceDto | null;
  @ApiProperty({
    description: 'At least one variant (or bundle configuration) can be bought',
  })
  inStock: boolean;
  @ApiProperty({ type: [StorefrontProductCardDto] })
  related: StorefrontProductCardDto[];
  @ApiProperty({ type: [StorefrontProductCardDto] })
  upsell: StorefrontProductCardDto[];
  @ApiProperty({ type: [StorefrontProductCardDto] })
  crossSell: StorefrontProductCardDto[];
}

// ─── Queries ───

const toArray = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];
export const FILTER_PATTERN =
  /^[a-z][a-z0-9_-]{0,63}:[a-z][a-z0-9_-]{0,63}(,[a-z][a-z0-9_-]{0,63})*$/;

export class CategoryProductsQueryDto {
  @ApiPropertyOptional({ type: 'integer', default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page: number = 1;
  @ApiPropertyOptional({
    type: 'integer',
    default: 24,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 24;
  @ApiPropertyOptional({
    enum: ['position', 'name', 'newest'],
    default: 'position',
  })
  @IsOptional()
  @IsIn(['position', 'name', 'newest'])
  sort: 'position' | 'name' | 'newest' = 'position';
  @ApiPropertyOptional({
    default: true,
    description: 'Include products of subcategories',
  })
  @IsOptional()
  @Transform(({ value }) => value !== false && value !== 'false')
  @IsBoolean()
  includeSubcategories: boolean = true;
  @ApiPropertyOptional({
    type: [String],
    example: ['color:red,blue', 'size:m'],
    description:
      'attribute:option[,option] — OR within, AND across; filterable attributes only',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(FILTER_PATTERN, { each: true })
  filter?: string[];
}

export class ResolveUrlQueryDto {
  @ApiProperty({ example: '/men/t-shirts' })
  @IsString()
  @MaxLength(1024)
  path: string;
}

export class StorefrontUrlResolutionDto {
  @ApiProperty({ enum: UrlTargetType, enumName: 'UrlTargetType' })
  type: UrlTargetType;
  @ApiProperty({ nullable: true, type: String }) id: string | null;
  @ApiProperty({ nullable: true, type: String }) canonicalPath: string | null;
  @ApiProperty({ nullable: true, type: Number, enum: [301, 302] })
  redirectStatus: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Where to redirect when redirectStatus is set',
  })
  location: string | null;
}
