import { ConflictException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import type { UrlTargetType } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { describeTarget, UrlRewritesQuery } from './url-rewrites.query.js';
import {
  CATEGORY_EVENTS,
  type CategoryWriteInput,
} from '../catalog/catalog.events.js';
import {
  PRODUCT_EVENTS,
  type ProductWriteInput,
} from '../products/products.events.js';

/**
 * Before-listener (may veto): a new slug must not land on a URL that already belongs to another
 * product, category or custom redirect in the same locale. Redirects left by renamed entities may
 * be taken over, so they don't block.
 */
@Injectable()
export class UrlCollisionListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly urls: UrlRewritesQuery,
  ) {}

  @OnEvent(PRODUCT_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  async onProductWrite(
    event: BeforeWriteEvent<ProductWriteInput>,
  ): Promise<void> {
    const slugs = event.input?.slugs ?? [];
    await this.assertFree(
      'PRODUCT',
      event.entityId,
      slugs.map((s) => ({ localeCode: s.localeCode, path: s.slug })),
    );
  }

  @OnEvent(CATEGORY_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  async onCategoryWrite(
    event: BeforeWriteEvent<CategoryWriteInput>,
  ): Promise<void> {
    const input = event.input;
    if (!input?.slugs.length) return;
    // The parent's canonical paths per locale (any store) give the category's future path.
    const parentPaths = input.parentId
      ? await this.prisma.urlRewrite.findMany({
          where: {
            targetType: 'CATEGORY',
            targetId: input.parentId,
            redirectType: null,
          },
          select: { localeCode: true, requestPath: true },
          distinct: ['localeCode', 'requestPath'],
        })
      : [];
    const candidates = input.slugs.flatMap((s) => {
      if (!input.parentId) return [{ localeCode: s.localeCode, path: s.slug }];
      return parentPaths
        .filter((p) => p.localeCode === s.localeCode)
        .map((p) => ({
          localeCode: s.localeCode,
          path: `${p.requestPath}/${s.slug}`,
        }));
    });
    await this.assertFree('CATEGORY', event.entityId, candidates);
  }

  private async assertFree(
    type: UrlTargetType,
    selfId: string | null,
    candidates: { localeCode: string; path: string }[],
  ): Promise<void> {
    const taken = await this.urls.taken(type, selfId, candidates);
    if (taken.length)
      throw new ConflictException(
        taken.map(
          (t) =>
            `The URL "/${t.requestPath}" (${t.localeCode}) already belongs to ${describeTarget(t.targetType)}; choose another slug`,
        ),
      );
  }
}
