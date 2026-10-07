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
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  FILTER_PATTERN,
  StorefrontProductCardDto,
} from '../../storefront/dto/storefront.dto.js';

const toArray = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];
const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

export class SearchQueryDto {
  @ApiPropertyOptional({
    example: 'red tee',
    description: 'Free text; empty browses (e.g. a category with facets)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
  @ApiPropertyOptional({
    description: 'Limit to a category and its subcategories',
  })
  @IsOptional()
  @IsUUID()
  category?: string;
  @ApiPropertyOptional({
    type: [String],
    example: ['color:red,blue', 'size:m'],
    description: 'attribute:option[,option] — OR within, AND across',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(FILTER_PATTERN, { each: true })
  filter?: string[];
  @ApiPropertyOptional({
    type: 'integer',
    description: 'Minor units, store default currency',
  })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  priceMin?: number;
  @ApiPropertyOptional({
    type: 'integer',
    description: 'Minor units, store default currency',
  })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  priceMax?: number;
  @ApiPropertyOptional({ description: 'Only products that can be bought' })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  inStock?: boolean;
  @ApiPropertyOptional({
    enum: ['relevance', 'price_asc', 'price_desc', 'name', 'newest'],
    default: 'relevance',
  })
  @IsOptional()
  @IsIn(['relevance', 'price_asc', 'price_desc', 'name', 'newest'])
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'name' | 'newest' =
    'relevance';
  @ApiPropertyOptional({ type: 'integer', default: 1, minimum: 1 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(1000)
  page: number = 1;
  @ApiPropertyOptional({
    type: 'integer',
    default: 24,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 24;
}

export class SuggestQueryDto {
  @ApiProperty({ example: 'tee', minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;
  @ApiPropertyOptional({ type: 'integer', default: 8, maximum: 20 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(20)
  limit: number = 8;
}

export class StorefrontFacetValueDto {
  @ApiProperty({ example: 'red' }) value: string;
  @ApiProperty({ example: 'Red' }) label: string;
  @ApiProperty() count: number;
  @ApiProperty({ nullable: true, type: String }) swatch: string | null;
  @ApiProperty({ description: 'Currently filtered by this value' })
  selected: boolean;
}

export class StorefrontFacetDto {
  @ApiProperty({ example: 'color' }) code: string;
  @ApiProperty({ example: 'Colour' }) label: string;
  @ApiProperty({ type: [StorefrontFacetValueDto] })
  values: StorefrontFacetValueDto[];
}

export class StorefrontCategoryFacetDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) parentId: string | null;
  @ApiProperty() count: number;
}

export class StorefrontPriceRangeDto {
  @ApiProperty({ description: 'Minor units, store default currency' })
  min: number;
  @ApiProperty() max: number;
  @ApiProperty({ example: 'USD' }) currency: string;
}

export class StorefrontSearchResultDto {
  @ApiProperty({ type: [StorefrontProductCardDto] })
  data: StorefrontProductCardDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({
    type: [StorefrontFacetDto],
    description:
      'Filterable attributes with counts (disjunctive: a selected facet keeps its alternatives)',
  })
  facets: StorefrontFacetDto[];
  @ApiProperty({ type: [StorefrontCategoryFacetDto] })
  categories: StorefrontCategoryFacetDto[];
  @ApiProperty({ type: StorefrontPriceRangeDto, nullable: true })
  priceRange: StorefrontPriceRangeDto | null;
}

export class StorefrontSuggestionDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) urlPath: string | null;
}
