import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CODE_MESSAGE,
  CODE_PATTERN,
  COUNTRY_PATTERN,
} from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  MovementReason,
  ReservationStatus,
} from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class InventorySourceDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'hcm-1' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'VN' }) countryCode: string;
  @ApiProperty() isActive: boolean;
}

export class CreateInventorySourceDto {
  @ApiProperty({ example: 'hcm-1' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'Ho Chi Minh City warehouse' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({ example: 'VN' }) @Matches(COUNTRY_PATTERN) countryCode: string;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateInventorySourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class WebsiteSourceInputDto {
  @ApiProperty() @IsUUID() sourceId: string;
  @ApiPropertyOptional({ description: 'Fulfilment order; lower first' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;
}

export class SetWebsiteSourcesDto {
  @ApiProperty({
    type: [WebsiteSourceInputDto],
    description: 'Replaces the sources selling into the website',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WebsiteSourceInputDto)
  sources: WebsiteSourceInputDto[];
}

export class WebsiteSourceDto {
  @ApiProperty() sourceId: string;
  @ApiProperty() code: string;
  @ApiProperty() priority: number;
}

export class StockAdjustmentDto {
  @ApiProperty() @IsUUID() sourceId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ example: 'TEE-RED-M' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;
  @ApiPropertyOptional({
    description: 'Change by this amount (+ receipt, − shrinkage)…',
  })
  @IsOptional()
  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  delta?: number;
  @ApiPropertyOptional({ description: '…or set the physical count' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  quantity?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  safetyStock?: number;
  @ApiPropertyOptional({
    enum: MovementReason,
    enumName: 'MovementReason',
    default: 'ADJUSTMENT',
  })
  @IsOptional()
  @IsEnum(MovementReason)
  reason?: MovementReason;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
  @ApiPropertyOptional({
    description:
      'Optimistic concurrency: fail with 409 if the stock row changed meanwhile',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class StockDto {
  @ApiProperty() sourceId: string;
  @ApiProperty() sourceCode: string;
  @ApiProperty() variantId: string;
  @ApiProperty() sku: string;
  @ApiProperty() quantity: number;
  @ApiProperty() reserved: number;
  @ApiProperty() safetyStock: number;
  @ApiProperty() salable: number;
  @ApiProperty() version: number;
}

export class ListStockQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sku?: string;
  @ApiPropertyOptional({ description: 'Stock of every variant of a product' })
  @IsOptional()
  @IsUUID()
  productId?: string;
  @ApiPropertyOptional({ description: 'SKU contains (case-insensitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

export class StockListDto {
  @ApiProperty({ type: [StockDto] }) data: StockDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class MovementDto {
  @ApiProperty() id: string;
  @ApiProperty() sourceId: string;
  @ApiProperty() variantId: string;
  @ApiProperty() sku: string;
  @ApiProperty() delta: number;
  @ApiProperty() quantityAfter: number;
  @ApiProperty({ enum: MovementReason, enumName: 'MovementReason' })
  reason: MovementReason;
  @ApiProperty({ nullable: true, type: String }) reference: string | null;
  @ApiProperty({ nullable: true, type: String }) note: string | null;
  @ApiProperty() actorLabel: string;
  @ApiProperty() createdAt: Date;
}

export class MovementListDto {
  @ApiProperty({ type: [MovementDto] }) data: MovementDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListMovementsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({
    description: 'Movements of every variant of a product',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

export class ReserveDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) sku?: string;
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(100_000) quantity: number;
  @ApiProperty({ example: 'CART' })
  @Matches(/^[A-Z][A-Z_]{1,31}$/)
  referenceType: string;
  @ApiProperty({ example: 'c0ffee' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  referenceId: string;
  @ApiPropertyOptional({
    default: 900,
    description: 'Released automatically after this many seconds',
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(7 * 86_400)
  ttlSeconds?: number;
  @ApiPropertyOptional({
    description:
      'Choose the group id to make retries safe (the group is reserved once)',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class ReservationLineDto {
  @ApiProperty() sourceId: string;
  @ApiProperty() quantity: number;
}

export class ReservationDto {
  @ApiProperty({ description: 'Use to release or convert' }) groupId: string;
  @ApiProperty() variantId: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status: ReservationStatus;
  @ApiProperty({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiProperty({
    description: 'False for virtual goods (no stock kept); nothing is reserved',
  })
  managed: boolean;
  @ApiProperty({ type: [ReservationLineDto] }) lines: ReservationLineDto[];
}

export class SalableQueryDto {
  @ApiProperty() @IsUUID() websiteId: string;
  @ApiProperty({ type: [String] })
  @Transform(({ value }) =>
    Array.isArray(value) ? value : String(value).split(','),
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  variantIds: string[];
}

export class SalableDto {
  @ApiProperty() variantId: string;
  @ApiProperty() managed: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'null when stock is not managed',
  })
  salable: number | null;
  @ApiProperty() inStock: boolean;
}
