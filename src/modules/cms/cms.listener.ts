import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ContentPublisher,
  type ContentStateEventData,
} from '../../common/content/content-publisher.js';
import {
  CONTENT_SCHEDULE_EVENTS,
  type ScheduleDueData,
} from '../../common/content/publishing.js';
import type {
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import {
  CATEGORY_EVENTS,
  type CategoryEventData,
} from '../catalog/catalog.events.js';
import { STORE_EVENTS, type StoreEventData } from '../stores/stores.events.js';
import { BlocksService } from './blocks.service.js';
import {
  BLOCK_EVENTS,
  type ContentEventData,
  PAGE_EVENTS,
  POST_EVENTS,
} from './cms.events.js';
import { CmsUrlsService } from './cms-urls.service.js';

const AFTER = { async: true, promisify: true } as const;

type UrlEvent = EntityEvent<
  Partial<ContentEventData> & Pick<ContentStateEventData, 'id' | 'storeId'>
>;

// Stacked @OnEvent: an array would be one namespaced event in wildcard mode.
/**
 * Keeps CMS projections in step (after-events; idempotent): page/post URLs follow slugs and the
 * publishing state, due schedules are applied, placements of deleted categories are removed.
 */
@Injectable()
export class CmsListener {
  constructor(
    private readonly urls: CmsUrlsService,
    private readonly publisher: ContentPublisher,
    private readonly blocks: BlocksService,
  ) {}

  @OnEvent(PAGE_EVENTS.CREATED, AFTER)
  @OnEvent(PAGE_EVENTS.UPDATED, AFTER)
  @OnEvent(PAGE_EVENTS.DELETED, AFTER)
  @OnEvent(PAGE_EVENTS.PUBLISHED, AFTER)
  @OnEvent(PAGE_EVENTS.UNPUBLISHED, AFTER)
  @OnEvent(PAGE_EVENTS.SCHEDULED, AFTER)
  onPage(e: UrlEvent) {
    return this.urls.rebuild(
      'page',
      e.data.id,
      e.data.storeId,
      e.data.previousSlugs ?? [],
    );
  }

  @OnEvent(POST_EVENTS.CREATED, AFTER)
  @OnEvent(POST_EVENTS.UPDATED, AFTER)
  @OnEvent(POST_EVENTS.DELETED, AFTER)
  @OnEvent(POST_EVENTS.PUBLISHED, AFTER)
  @OnEvent(POST_EVENTS.UNPUBLISHED, AFTER)
  @OnEvent(POST_EVENTS.SCHEDULED, AFTER)
  onPost(e: UrlEvent) {
    return this.urls.rebuild(
      'post',
      e.data.id,
      e.data.storeId,
      e.data.previousSlugs ?? [],
    );
  }

  @OnEvent(CONTENT_SCHEDULE_EVENTS.DUE, AFTER)
  async onDue(e: ProjectionEvent<ScheduleDueData>) {
    const { targetType, targetId, action } = e.data;
    if (targetType === 'PAGE')
      await this.publisher.due('page', targetId, action, PAGE_EVENTS);
    else if (targetType === 'POST')
      await this.publisher.due('post', targetId, action, POST_EVENTS);
    else if (targetType === 'BLOCK')
      await this.publisher.due('block', targetId, action, BLOCK_EVENTS);
  }

  @OnEvent(STORE_EVENTS.CREATED, AFTER)
  onStoreCreated() {
    return this.urls.rebuildAll();
  }

  @OnEvent(STORE_EVENTS.UPDATED, AFTER)
  async onStoreUpdated(e: EntityEvent<StoreEventData>) {
    if (e.data.localesChanged) await this.urls.rebuildAll();
  }

  @OnEvent(CATEGORY_EVENTS.DELETED, AFTER)
  async onCategoryDeleted(e: EntityEvent<CategoryEventData>) {
    await this.blocks.removePlacementsOf('CATEGORY', e.data.categoryId);
  }
}
