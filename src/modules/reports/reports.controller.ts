import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/auth.decorators.js';
import { OverviewDto, OverviewQueryDto } from './dto/report.dto.js';
import { ReportsQuery } from './reports.query.js';

@ApiTags('admin · reports')
@Controller('admin/reports')
export class ReportsAdminController {
  constructor(private readonly reports: ReportsQuery) {}

  @Get('overview')
  @RequirePermissions('orders:read')
  @ApiOperation({
    summary:
      'Dashboard KPIs: sales, orders, average order value, new customers, daily series and top products',
  })
  @ApiOkResponse({ type: OverviewDto })
  overview(@Query() q: OverviewQueryDto) {
    return this.reports.overview(q);
  }
}
