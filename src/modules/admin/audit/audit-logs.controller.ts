import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/auth.decorators.js';
import { AuditLogsService } from './audit-logs.service.js';
import { AuditLogPageDto, ListAuditLogsQueryDto } from './dto/audit-log.dto.js';

@ApiTags('admin · audit')
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  @RequirePermissions('audit-logs:read')
  @ApiOperation({ summary: 'Who changed what (newest first by default)' })
  @ApiOkResponse({ type: AuditLogPageDto })
  list(@Query() q: ListAuditLogsQueryDto) {
    return this.logs.list(q);
  }
}
