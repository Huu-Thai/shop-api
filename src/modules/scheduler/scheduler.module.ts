import { Module } from '@nestjs/common';
import { SchedulerController } from './scheduler.controller.js';
import { SchedulerListener } from './scheduler.listener.js';
import { SchedulerService } from './scheduler.service.js';

/** Time-based publish/unpublish for content modules (owns `schedules`). */
@Module({
  controllers: [SchedulerController],
  providers: [SchedulerService, SchedulerListener],
  exports: [SchedulerService],
})
export class SchedulerModule {}
