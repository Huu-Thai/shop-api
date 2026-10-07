import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import {
  CONTENT_SCHEDULE_EVENTS,
  type ScheduleDueData,
} from '../../common/content/publishing.js';
import type { ProjectionEvent } from '../../common/events/entity.events.js';
import { BANNER_EVENTS, SLIDER_EVENTS } from './merchandising.events.js';

const AFTER = { async: true, promisify: true } as const;

/** Applies due banner/slider schedules. */
@Injectable()
export class MerchandisingListener {
  constructor(private readonly publisher: ContentPublisher) {}

  @OnEvent(CONTENT_SCHEDULE_EVENTS.DUE, AFTER)
  async onDue(e: ProjectionEvent<ScheduleDueData>) {
    const { targetType, targetId, action } = e.data;
    if (targetType === 'BANNER')
      await this.publisher.due('banner', targetId, action, BANNER_EVENTS);
    else if (targetType === 'SLIDER')
      await this.publisher.due('slider', targetId, action, SLIDER_EVENTS);
  }
}
