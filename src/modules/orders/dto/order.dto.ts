import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsDateString,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  OrderFulfillmentStatus,
  OrderPaymentStatus,
  OrderStatus,
} from '../../../database/generated/prisma/enums.js';
import { CartAddressViewDto, MoneyDto } from '../../carts/dto/cart.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OrderItemDto {
  @ApiProperty() id: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() type: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyDto }) unitPrice: MoneyDto;
  @ApiProperty({ type: MoneyDto }) rowTotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax: MoneyDto;
  @ApiProperty({ example: '7.2500' }) taxRate: string;
  @ApiProperty() qtyShipped: number;
  @ApiProperty() qtyRefunded: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Configurable attributes and bundle choices',
  })
  options: Record<string, unknown>;
  @ApiProperty({ type: () => [OrderItemDto], description: 'Bundle components' })
  children: OrderItemDto[];
}

export class OrderTotalsDto {
  @ApiProperty({ type: MoneyDto }) subtotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty({ type: MoneyDto }) shipping: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax: MoneyDto;
  @ApiProperty({ type: MoneyDto }) grandTotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) loyalty: MoneyDto;
  @ApiProperty({ type: MoneyDto }) amountDue: MoneyDto;
  @ApiProperty({ type: MoneyDto }) amountPaid: MoneyDto;
  @ApiProperty({ type: MoneyDto }) amountRefunded: MoneyDto;
  @ApiProperty() pricesIncludeTax: boolean;
}

export class OrderShipmentItemDto {
  @ApiProperty() orderItemId: string;
  @ApiProperty() sku: string;
  @ApiProperty() quantity: number;
}

export class OrderShipmentDto {
  @ApiProperty() id: string;
  @ApiProperty() number: string;
  @ApiProperty() carrier: string;
  @ApiProperty({ nullable: true, type: String }) trackingNumber: string | null;
  @ApiProperty({ nullable: true, type: String }) trackingUrl: string | null;
  @ApiProperty({ enum: ['SHIPPED', 'DELIVERED'] }) status: string;
  @ApiProperty() shippedAt: Date;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt: Date | null;
  @ApiProperty({ type: [OrderShipmentItemDto] }) items: OrderShipmentItemDto[];
}

export class OrderDocumentDto {
  @ApiProperty() number: string;
  @ApiProperty({ type: MoneyDto }) amount: MoneyDto;
  @ApiProperty() issuedAt: Date;
}

export class OrderHistoryDto {
  @ApiProperty() event: string;
  @ApiProperty() message: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({ description: 'Staff views only' }) actorLabel?: string;
  @ApiPropertyOptional({ description: 'Staff views only' }) isPublic?: boolean;
}

export class OrderPromotionDto {
  @ApiProperty() label: string;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
}

export class OrderDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'US-000042' }) number: string;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status: OrderStatus;
  @ApiProperty({ enum: OrderPaymentStatus, enumName: 'OrderPaymentStatus' })
  paymentStatus: OrderPaymentStatus;
  @ApiProperty({
    enum: OrderFulfillmentStatus,
    enumName: 'OrderFulfillmentStatus',
  })
  fulfillmentStatus: OrderFulfillmentStatus;
  @ApiProperty() email: string;
  @ApiProperty() currency: string;
  @ApiProperty() placedAt: Date;
  @ApiProperty({ nullable: true, type: Date }) paidAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) canceledAt: Date | null;
  @ApiProperty({ type: [OrderItemDto] }) items: OrderItemDto[];
  @ApiProperty({ type: OrderTotalsDto }) totals: OrderTotalsDto;
  @ApiProperty({ nullable: true, type: CartAddressViewDto })
  shippingAddress: CartAddressViewDto | null;
  @ApiProperty({ nullable: true, type: CartAddressViewDto })
  billingAddress: CartAddressViewDto | null;
  @ApiProperty({ nullable: true, type: String }) shippingMethod: string | null;
  @ApiProperty({ nullable: true, type: String }) couponCode: string | null;
  @ApiProperty() loyaltyPoints: number;
  @ApiProperty({ type: [OrderPromotionDto] }) promotions: OrderPromotionDto[];
  @ApiProperty({ type: [OrderShipmentDto] }) shipments: OrderShipmentDto[];
  @ApiProperty({ type: [OrderDocumentDto] }) invoices: OrderDocumentDto[];
  @ApiProperty({ type: [OrderDocumentDto] }) creditMemos: OrderDocumentDto[];
  @ApiProperty({
    type: [OrderHistoryDto],
    description: 'Public timeline (staff see every entry)',
  })
  history: OrderHistoryDto[];
  @ApiPropertyOptional({
    description:
      'Guests: send as X-Order-Token to read and pay the order (returned when placed)',
  })
  accessToken?: string;
}

export class OrderSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() number: string;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status: OrderStatus;
  @ApiProperty({ enum: OrderPaymentStatus, enumName: 'OrderPaymentStatus' })
  paymentStatus: OrderPaymentStatus;
  @ApiProperty({
    enum: OrderFulfillmentStatus,
    enumName: 'OrderFulfillmentStatus',
  })
  fulfillmentStatus: OrderFulfillmentStatus;
  @ApiProperty({ type: MoneyDto }) grandTotal: MoneyDto;
  @ApiProperty() itemCount: number;
  @ApiProperty() placedAt: Date;
}

export class OrderListDto {
  @ApiProperty({ type: [OrderSummaryDto] }) data: OrderSummaryDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class AdminOrderDto extends OrderDto {
  @ApiProperty() storeId: string;
  @ApiProperty({ nullable: true, type: String }) customerId: string | null;
  @ApiProperty() customerGroupCode: string;
}

export class AdminOrderSummaryDto extends OrderSummaryDto {
  @ApiProperty() email: string;
  @ApiProperty() storeId: string;
}

export class AdminOrderListDto {
  @ApiProperty({ type: [AdminOrderSummaryDto] }) data: AdminOrderSummaryDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ enum: OrderStatus, enumName: 'OrderStatus' })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
  @ApiPropertyOptional({
    enum: OrderPaymentStatus,
    enumName: 'OrderPaymentStatus',
  })
  @IsOptional()
  @IsEnum(OrderPaymentStatus)
  paymentStatus?: OrderPaymentStatus;
  @ApiPropertyOptional({
    enum: OrderFulfillmentStatus,
    enumName: 'OrderFulfillmentStatus',
  })
  @IsOptional()
  @IsEnum(OrderFulfillmentStatus)
  fulfillmentStatus?: OrderFulfillmentStatus;
  @ApiPropertyOptional({ description: 'Placed at or after (ISO date or time)' })
  @IsOptional()
  @IsDateString()
  placedFrom?: string;
  @ApiPropertyOptional({ description: 'Placed before (ISO date or time)' })
  @IsOptional()
  @IsDateString()
  placedTo?: string;
  @ApiPropertyOptional({ description: 'Number or e-mail contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ShipItemDto {
  @ApiProperty() @IsUUID() orderItemId: string;
  @ApiProperty() @IsInt() @Min(1) quantity: number;
}

export class CreateShipmentDto {
  @ApiProperty({ example: 'ups' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(trim)
  carrier: string;
  @ApiPropertyOptional({ example: '1Z999' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  trackingNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^https:\/\/\S+$/, { message: 'trackingUrl must be an https URL' })
  @MaxLength(512)
  trackingUrl?: string;
  @ApiPropertyOptional({
    type: [ShipItemDto],
    description: 'Omit to ship everything still open',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipItemDto)
  items?: ShipItemDto[];
}

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Changed my mind' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class OrderNoteDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) message: string;
  @ApiPropertyOptional({
    default: false,
    description: 'Visible to the customer',
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class ShipmentResultDto {
  @ApiProperty() number: string;
}
