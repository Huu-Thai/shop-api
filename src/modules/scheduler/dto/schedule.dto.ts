import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import {
  ContentType,
  ScheduleAction,
  ScheduleStatus,
} from '../../../database/generated/prisma/enums.js';

export class ScheduleDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ContentType, enumName: 'ContentType' })
  targetType: ContentType;
  @ApiProperty() targetId: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'What the target is called (title, name or identifier); null once it is deleted',
  })
  targetLabel: string | null;
  @ApiProperty({ enum: ScheduleAction, enumName: 'ScheduleAction' })
  action: ScheduleAction;
  @ApiProperty() runAt: Date;
  @ApiProperty({ enum: ScheduleStatus, enumName: 'ScheduleStatus' })
  status: ScheduleStatus;
  @ApiProperty() attempts: number;
  @ApiProperty({ nullable: true, type: Date }) executedAt: Date | null;
  @ApiProperty({ nullable: true, type: String }) createdById: string | null;
  @ApiProperty() createdAt: Date;
}

export class ListSchedulesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ScheduleStatus, enumName: 'ScheduleStatus' })
  @IsOptional()
  @IsEnum(ScheduleStatus)
  status?: ScheduleStatus;
  @ApiPropertyOptional({ enum: ContentType, enumName: 'ContentType' })
  @IsOptional()
  @IsEnum(ContentType)
  targetType?: ContentType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() targetId?: string;
}

export class ScheduleListDto {
  @ApiProperty({ type: [ScheduleDto] }) data: ScheduleDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
