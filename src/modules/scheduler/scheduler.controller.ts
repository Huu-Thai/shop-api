import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/auth.decorators.js';
import { ListSchedulesQueryDto, ScheduleListDto } from './dto/schedule.dto.js';
import { SchedulerService } from './scheduler.service.js';

@ApiTags('admin · schedules')
@Controller('admin/schedules')
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get()
  @RequirePermissions('cms:read')
  @ApiOperation({
    summary:
      'Publish/unpublish schedules (change them with the content’s publish and unpublish endpoints)',
  })
  @ApiOkResponse({ type: ScheduleListDto })
  list(@Query() q: ListSchedulesQueryDto) {
    return this.scheduler.list(q);
  }
}
