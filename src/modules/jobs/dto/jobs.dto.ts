import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  PageMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto.js';

export class JobTypeDto {
  @ApiProperty({ example: 'export.orders' }) type: string;
  @ApiProperty() title: string;
  @ApiProperty() description: string;
  @ApiProperty({ example: 'orders:read' }) permission: string;
  @ApiPropertyOptional({ enum: ['csv'] }) input?: 'csv';
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  exampleParams?: Record<string, unknown>;
}

export class CreateJobDto {
  @ApiProperty({ example: 'nightly-orders-export' })
  @Matches(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, {
    message: 'code: lowercase letters, digits, "-", "_" or "."',
  })
  @MaxLength(64)
  code: string;

  @ApiProperty({ example: 'Nightly orders export' })
  @IsString()
  @Length(1, 255)
  name: string;

  @ApiProperty({ example: 'export.orders' })
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { since: 'P1D' },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '0 2 * * *',
    description: 'Five-field cron expression; omit to run on demand only',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cron?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Ho_Chi_Minh', default: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateJobDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cron?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class JobDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() type: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  params: Record<string, unknown>;
  @ApiPropertyOptional({ nullable: true, type: String }) cron: string | null;
  @ApiProperty() timezone: string;
  @ApiProperty() isActive: boolean;
  @ApiPropertyOptional({ nullable: true, type: Date }) lastRunAt: Date | null;
  @ApiPropertyOptional({
    nullable: true,
    type: Date,
    description: 'Next scheduled run (active jobs with a cron expression)',
  })
  nextRunAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class RunJobDto {
  @ApiProperty({ example: 'export.orders' })
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

const STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'];

export class ListExecutionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) type?: string;
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
}

export class RowErrorDto {
  @ApiProperty() row: number;
  @ApiProperty() message: string;
}

export class ExecutionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid', type: String }) jobId:
    string | null;
  @ApiProperty() type: string;
  @ApiProperty({ enum: STATUSES }) status: string;
  @ApiProperty({ enum: ['SCHEDULE', 'MANUAL'] }) trigger: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  params: Record<string, unknown>;
  @ApiProperty({ minimum: 0, maximum: 100 }) progress: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { rows: 1200, updated: 1180, failed: 20 },
  })
  stats: Record<string, number>;
  @ApiProperty({ type: [RowErrorDto] }) errors: RowErrorDto[];
  @ApiPropertyOptional({ nullable: true, type: String }) error: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'File name of the result (exports)',
  })
  outputName: string | null;
  @ApiProperty() cancelRequested: boolean;
  @ApiProperty() actorLabel: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({ nullable: true, type: Date }) startedAt: Date | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) finishedAt: Date | null;
}

export class ExecutionPageDto extends PageMetaDto {
  @ApiProperty({ type: [ExecutionDto] }) data: ExecutionDto[];
}

export class DownloadDto {
  @ApiProperty({ description: 'Signed URL, valid for a few minutes' })
  url: string;
  @ApiProperty() name: string;
}

/** Multipart fields next to the uploaded CSV (`file`). */
export class StartImportDto {
  @ApiProperty({ example: 'import.prices' })
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiPropertyOptional({
    description: 'Parameters as a JSON object (multipart fields are text)',
    example: '{"mode":"upsert"}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  params?: string;
}
