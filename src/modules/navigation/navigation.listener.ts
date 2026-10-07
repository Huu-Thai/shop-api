import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { EntityEvent } from '../../common/events/entity.events.js';
import {
  CATEGORY_EVENTS,
  type CategoryEventData,
} from '../catalog/catalog.events.js';
import {
  type ContentEventData,
  PAGE_EVENTS,
  POST_EVENTS,
} from '../cms/cms.events.js';
import { MenusService } from './menus.service.js';

const AFTER = { async: true, promisify: true } as const;

/** Menu links whose target was deleted are deactivated (editors see and fix them). */
@Injectable()
export class NavigationListener {
  constructor(private readonly menus: MenusService) {}

  @OnEvent(PAGE_EVENTS.DELETED, AFTER)
  async onPageDeleted(e: EntityEvent<ContentEventData>) {
    await this.menus.deactivateLinksTo('PAGE', e.data.id);
  }

  @OnEvent(POST_EVENTS.DELETED, AFTER)
  async onPostDeleted(e: EntityEvent<ContentEventData>) {
    await this.menus.deactivateLinksTo('POST', e.data.id);
  }

  @OnEvent(CATEGORY_EVENTS.DELETED, AFTER)
  async onCategoryDeleted(e: EntityEvent<CategoryEventData>) {
    await this.menus.deactivateLinksTo('CATEGORY', e.data.categoryId);
  }
}
