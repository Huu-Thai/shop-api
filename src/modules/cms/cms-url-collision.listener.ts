import { ConflictException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import type { UrlTargetType } from '../../database/generated/prisma/client.js';
import {
  describeTarget,
  UrlRewritesQuery,
} from '../url-rewrites/url-rewrites.query.js';
import {
  type ContentWriteInput,
  PAGE_EVENTS,
  POST_EVENTS,
} from './cms.events.js';
import { PAGE_PREFIX, POST_PREFIX } from './content-urls.js';

/**
 * Before-listener (may veto): a page or post slug must not land on a URL of a product, category,
 * redirect or the other content kind. Duplicates within pages (or posts) are checked by their
 * services, since a store item may deliberately shadow a global one.
 */
@Injectable()
export class CmsUrlCollisionListener {
  constructor(private readonly urls: UrlRewritesQuery) {}

  @OnEvent(PAGE_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  onPageWrite(e: BeforeWriteEvent<ContentWriteInput>) {
    return this.check('CMS_PAGE', PAGE_PREFIX, e);
  }

  @OnEvent(POST_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  onPostWrite(e: BeforeWriteEvent<ContentWriteInput>) {
    return this.check('CMS_POST', POST_PREFIX, e);
  }

  private async check(
    type: UrlTargetType,
    prefix: string,
    e: BeforeWriteEvent<ContentWriteInput>,
  ): Promise<void> {
    const slugs = e.input?.slugs;
    if (!slugs?.length) return;
    const taken = await this.urls.taken(
      type,
      e.entityId,
      slugs.map((s) => ({
        localeCode: s.localeCode,
        path: `${prefix}${s.slug}`,
      })),
      { storeId: e.input!.storeId, ignoreType: type },
    );
    if (taken.length)
      throw new ConflictException(
        taken.map(
          (t) =>
            `The URL "/${t.requestPath}" (${t.localeCode}) already belongs to ${describeTarget(t.targetType)}; choose another slug`,
        ),
      );
  }
}
