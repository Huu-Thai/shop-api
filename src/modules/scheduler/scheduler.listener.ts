import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CONTENT_SCHEDULE_EVENTS,
  type ScheduleRequestedData,
} from '../../common/content/publishing.js';
import type { ProjectionEvent } from '../../common/events/entity.events.js';
import { SchedulerService } from './scheduler.service.js';

const AFTER = { async: true, promisify: true } as const;

@Injectable()
export class SchedulerListener {
  constructor(private readonly scheduler: SchedulerService) {}

  @OnEvent(CONTENT_SCHEDULE_EVENTS.REQUESTED, AFTER)
  async onRequested(e: ProjectionEvent<ScheduleRequestedData>): Promise<void> {
    await this.scheduler.apply(e.data.requests, e.data.actorId);
  }
}
