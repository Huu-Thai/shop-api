import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { MoneyDto } from '../../carts/dto/cart.dto.js';

export class OverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Days back from today (UTC), today included',
    default: 30,
    minimum: 1,
    maximum: 366,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;

  @ApiPropertyOptional({
    description:
      'Currency of the money figures (default: the one with the most revenue in the period)',
    example: 'USD',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}

export class OverviewTotalsDto {
  @ApiProperty({ type: MoneyDto }) revenue: MoneyDto;
  @ApiProperty() orders: number;
  @ApiProperty({ type: MoneyDto }) averageOrderValue: MoneyDto;
  @ApiProperty() newCustomers: number;
}

export class OverviewDayDto {
  @ApiProperty({ example: '2026-10-05' }) date: string;
  @ApiProperty({ description: 'Minor units' }) revenue: number;
  @ApiProperty() orders: number;
}

export class TopProductDto {
  @ApiProperty({ nullable: true, type: String }) productId: string | null;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyDto }) revenue: MoneyDto;
}

export class StatusCountDto {
  @ApiProperty() status: string;
  @ApiProperty() count: number;
}

export class OverviewDto {
  @ApiProperty() from: Date;
  @ApiProperty() to: Date;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null when no order was placed in the period',
  })
  currency: string | null;
  @ApiProperty({
    type: [String],
    description: 'Currencies with orders in the period',
  })
  currencies: string[];
  @ApiProperty({ type: OverviewTotalsDto }) current: OverviewTotalsDto;
  @ApiProperty({
    type: OverviewTotalsDto,
    description: 'The period of the same length just before',
  })
  previous: OverviewTotalsDto;
  @ApiProperty({ type: [OverviewDayDto] }) daily: OverviewDayDto[];
  @ApiProperty({ type: [TopProductDto] }) topProducts: TopProductDto[];
  @ApiProperty({
    type: [StatusCountDto],
    description: 'Orders placed in the period by status (all currencies)',
  })
  byStatus: StatusCountDto[];
}
