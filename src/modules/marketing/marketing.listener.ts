import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ContentPublisher } from '../../common/content/content-publisher.js';
import {
  CONTENT_SCHEDULE_EVENTS,
  type ScheduleDueData,
} from '../../common/content/publishing.js';
import type { ProjectionEvent } from '../../common/events/entity.events.js';
import { CAMPAIGN_EVENTS, PROMOTION_EVENTS } from './marketing.events.js';

const AFTER = { async: true, promisify: true } as const;

/** Applies due campaign and promotion schedules (start/end recorded, audited). */
@Injectable()
export class MarketingListener {
  constructor(private readonly publisher: ContentPublisher) {}

  @OnEvent(CONTENT_SCHEDULE_EVENTS.DUE, AFTER)
  async onDue(e: ProjectionEvent<ScheduleDueData>) {
    const { targetType, targetId, action } = e.data;
    if (targetType === 'CAMPAIGN')
      await this.publisher.due('campaign', targetId, action, CAMPAIGN_EVENTS);
    else if (targetType === 'PROMOTION')
      await this.publisher.due('promotion', targetId, action, PROMOTION_EVENTS);
  }
}
