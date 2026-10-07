import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobExecutor } from './job-executor.js';
import { JobRegistry } from './job-registry.js';
import { JobSchedules } from './job-schedules.js';
import { JobsController } from './jobs.controller.js';
import { JobsHousekeeping } from './jobs-housekeeping.js';
import { JobsService } from './jobs.service.js';

/**
 * Jobs and executions (PLAN.md §5). Job types are `@JobHandler()` providers of other modules,
 * discovered at start, so this module depends on none of them.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [JobsController],
  providers: [
    JobRegistry,
    JobsService,
    JobExecutor,
    JobSchedules,
    JobsHousekeeping,
  ],
  exports: [JobsService, JobExecutor, JobSchedules, JobsHousekeeping],
})
export class JobsModule {}
