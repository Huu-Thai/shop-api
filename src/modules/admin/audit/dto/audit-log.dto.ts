import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PageMetaDto,
  PaginationQueryDto,
} from '../../../../common/dto/pagination.dto.js';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'admin_user' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;
  @ApiPropertyOptional({
    example: 'auth.login-failed',
    description: 'Exact action, or a prefix ending in `.` (e.g. `auth.`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['admin', 'api-key', 'system', 'customer'] })
  actorType: string;
  @ApiPropertyOptional({ nullable: true, type: String }) actorId: string | null;
  @ApiProperty() actorLabel: string;
  @ApiProperty() action: string;
  @ApiProperty() entityType: string;
  @ApiPropertyOptional({ nullable: true, type: String }) entityId:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) changes: unknown;
  @ApiPropertyOptional({ nullable: true, type: String }) requestId:
    string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) ip: string | null;
  @ApiProperty() createdAt: Date;
}

export class AuditLogPageDto extends PageMetaDto {
  @ApiProperty({ type: [AuditLogDto] }) data: AuditLogDto[];
}
