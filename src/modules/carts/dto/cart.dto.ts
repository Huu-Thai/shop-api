import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
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
import { COUNTRY_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class BundleChoiceDto {
  @ApiProperty({ example: 'shirt', description: 'Bundle option code' })
  @IsString()
  @MaxLength(64)
  option: string;
  @ApiProperty({ example: 'TEE-RED-M' }) @IsString() @MaxLength(64) sku: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;
}

export class AddCartItemDto {
  @ApiProperty({
    example: 'TEE-RED-M',
    description:
      'Variant SKU (or the product SKU of a simple product or bundle)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(10_000) quantity: number;
  @ApiPropertyOptional({
    type: [BundleChoiceDto],
    description: 'Bundle choices (defaults fill the rest)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BundleChoiceDto)
  options?: BundleChoiceDto[];
}

export class UpdateCartItemDto {
  @ApiProperty() @IsInt() @Min(1) @Max(10_000) quantity: number;
}

export class CouponCodeDto {
  @ApiProperty({ example: 'WELCOME10' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Transform(trim)
  code: string;
}

export class CartEmailDto {
  @ApiProperty({ example: 'ann@example.com' })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;
}

export class CartAddressDto {
  @ApiPropertyOptional({
    description:
      'An address of the signed-in customer’s address book (instead of the fields)',
  })
  @IsOptional()
  @IsUUID()
  addressId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[+0-9 ()-]{4,32}$/)
  phone?: string;
  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @Transform(upper)
  @Matches(COUNTRY_PATTERN)
  countryCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z0-9-]{1,16}$/)
  regionCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  city?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  postcode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  line1?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  line2?: string;
}

export class SetAddressesDto {
  @ApiPropertyOptional({ type: CartAddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CartAddressDto)
  shipping?: CartAddressDto;
  @ApiPropertyOptional({
    type: CartAddressDto,
    description: 'Omit to bill to the shipping address',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CartAddressDto)
  billing?: CartAddressDto;
}

export class ShippingMethodChoiceDto {
  @ApiProperty({ example: 'standard' }) @IsString() @MaxLength(64) code: string;
}

export class LoyaltyPointsDto {
  @ApiProperty({ example: 500, description: '0 removes points from the cart' })
  @IsInt()
  @Min(0)
  points: number;
}

export class MergeCartDto {
  @ApiProperty({
    description:
      'The guest cart token to merge into the signed-in customer’s cart',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;
}

// ─── Views ───

export class MoneyDto {
  @ApiProperty({ description: 'Minor units' }) amount: number;
  @ApiProperty({ example: '$25.00' }) formatted: string;
}

export class CartLineViewDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) productId: string | null;
  @ApiProperty() variantId: string;
  @ApiProperty() type: string;
  @ApiProperty() quantity: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Configurable choices',
  })
  attributes: Record<string, string>;
  @ApiProperty({ type: [BundleChoiceDto] }) options: BundleChoiceDto[];
  @ApiProperty({ type: MoneyDto }) unitPrice: MoneyDto;
  @ApiProperty({ type: MoneyDto }) rowTotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax: MoneyDto;
  @ApiProperty() available: boolean;
  @ApiProperty({ nullable: true, type: String }) message: string | null;
}

export class CartAddressViewDto {
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ nullable: true, type: String }) company: string | null;
  @ApiProperty({ nullable: true, type: String }) phone: string | null;
  @ApiProperty() countryCode: string;
  @ApiProperty({ nullable: true, type: String }) regionCode: string | null;
  @ApiProperty() city: string;
  @ApiProperty({ nullable: true, type: String }) postcode: string | null;
  @ApiProperty() line1: string;
  @ApiProperty({ nullable: true, type: String }) line2: string | null;
}

export class ShippingOptionDto {
  @ApiProperty() code: string;
  @ApiProperty() carrier: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ type: MoneyDto }) price: MoneyDto;
}

export class CartCouponDto {
  @ApiProperty() code: string;
  @ApiProperty({ example: 'APPLIED' }) status: string;
  @ApiProperty() message: string;
}

export class CartPromotionDto {
  @ApiProperty() label: string;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty() freeShipping: boolean;
}

export class CartTotalsDto {
  @ApiProperty({ type: MoneyDto }) subtotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty({ type: MoneyDto }) shipping: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'What the order costs' })
  grandTotal: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Paid with points' })
  loyalty: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Left to pay' })
  amountDue: MoneyDto;
  @ApiProperty({ description: 'Prices and the tax line are tax-inclusive' })
  pricesIncludeTax: boolean;
}

export class CartDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional({
    description:
      'Guest carts: send it as X-Cart-Token (returned only when the cart is created)',
  })
  token?: string;
  @ApiProperty() currency: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ type: [CartLineViewDto] }) items: CartLineViewDto[];
  @ApiProperty() itemCount: number;
  @ApiProperty({ nullable: true, type: CartCouponDto })
  coupon: CartCouponDto | null;
  @ApiProperty({ type: [CartPromotionDto] }) promotions: CartPromotionDto[];
  @ApiProperty({ nullable: true, type: CartAddressViewDto })
  shippingAddress: CartAddressViewDto | null;
  @ApiProperty({ nullable: true, type: CartAddressViewDto })
  billingAddress: CartAddressViewDto | null;
  @ApiProperty({ description: 'The cart has physical goods' })
  requiresShipping: boolean;
  @ApiProperty({ nullable: true, type: ShippingOptionDto })
  shippingMethod: ShippingOptionDto | null;
  @ApiProperty() loyaltyPoints: number;
  @ApiProperty({ type: CartTotalsDto }) totals: CartTotalsDto;
  @ApiProperty({
    type: [String],
    example: ['shippingMethod'],
    description: 'What still blocks checkout',
  })
  missing: string[];
  @ApiProperty({ type: [String] }) warnings: string[];
  @ApiProperty({ description: 'Changes with every update (ETag)' })
  version: number;
}
