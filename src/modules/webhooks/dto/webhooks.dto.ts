import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import {
  PageMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto.js';

export class WebhookEventTypeDto {
  @ApiProperty({ example: 'order.paid' }) type: string;
  @ApiProperty() description: string;
}

export class CreateWebhookDto {
  @ApiProperty({ example: 'ERP orders' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiProperty({ example: 'https://erp.example.com/hooks/shop' })
  @IsString()
  @MaxLength(2048)
  url: string;

  @ApiProperty({
    example: ['order.*', 'payment.refunded'],
    description:
      'Event names or `prefix.*` patterns (GET /admin/webhooks/events)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  events: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  events?: string[];
  @ApiPropertyOptional({
    description:
      'Re-enabling a webhook that was switched off resets its failure count',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class WebhookDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() url: string;
  @ApiProperty({ type: [String] }) events: string[];
  @ApiProperty() isActive: boolean;
  @ApiProperty({
    description: 'Deliveries that failed in a row (after all their retries)',
  })
  consecutiveFailures: number;
  @ApiPropertyOptional({ nullable: true, type: String }) disabledReason:
    string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class WebhookWithSecretDto extends WebhookDto {
  @ApiProperty({
    description:
      'Signing secret — shown only now (and when rotated); store it in the receiver',
  })
  secret: string;
}

const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'];

export class ListDeliveriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export class WebhookDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) webhookId: string;
  @ApiProperty({ format: 'uuid' }) eventId: string;
  @ApiProperty() eventName: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) payload: unknown;
  @ApiProperty({ enum: STATUSES }) status: string;
  @ApiProperty() attempts: number;
  @ApiPropertyOptional({ nullable: true, type: Number }) responseStatus:
    number | null;
  @ApiPropertyOptional({ nullable: true, type: String }) responseBody:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) error: string | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) durationMs:
    number | null;
  @ApiPropertyOptional({ nullable: true, type: Date })
  nextAttemptAt: Date | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) deliveredAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class WebhookDeliveryPageDto extends PageMetaDto {
  @ApiProperty({ type: [WebhookDeliveryDto] }) data: WebhookDeliveryDto[];
}
