import { Module } from '@nestjs/common';
import { ReportsAdminController } from './reports.controller.js';
import { ReportsQuery } from './reports.query.js';

/** Back-office reports for the admin dashboard. */
@Module({
  controllers: [ReportsAdminController],
  providers: [ReportsQuery],
})
export class ReportsModule {}
