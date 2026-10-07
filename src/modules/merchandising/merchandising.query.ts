import { Injectable } from '@nestjs/common';
import { visibleWhere } from '../../common/content/publishing.js';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { PrismaService } from '../../database/prisma.service.js';
import { MediaQuery } from '../media/media.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import type {
  StorefrontBannerDto,
  StorefrontSliderDto,
} from './dto/merchandising.dto.js';

const live = (ctx: StoreContext, now: Date) => ({
  AND: [
    visibleWhere(now),
    { OR: [{ storeId: null }, { storeId: ctx.storeId }] },
  ],
});

/** Storefront banners and sliders: visible now, in this store, texts in the locale chain. */
@Injectable()
export class MerchandisingQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaQuery,
  ) {}

  async banners(
    ctx: StoreContext,
    placement: string,
  ): Promise<StorefrontBannerDto[]> {
    const rows = await this.prisma.banner.findMany({
      where: { placement, ...live(ctx, new Date()) },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        placement: true,
        linkUrl: true,
        imageId: true,
        translations: {
          where: { localeCode: { in: ctx.localeChain } },
          select: {
            localeCode: true,
            title: true,
            subtitle: true,
            ctaLabel: true,
            imageId: true,
          },
        },
      },
    });
    const view = rows.map((r) => {
      const t = pickTranslation(r.translations, ctx.localeChain);
      return { r, t, imageId: t?.imageId ?? r.imageId };
    });
    const images = await this.media.imagesById(
      view.map((v) => v.imageId),
      ctx.localeChain,
    );
    return view.map(({ r, t, imageId }) => ({
      id: r.id,
      placement: r.placement,
      title: t?.title ?? null,
      subtitle: t?.subtitle ?? null,
      ctaLabel: t?.ctaLabel ?? null,
      linkUrl: r.linkUrl,
      image: (imageId && images.get(imageId)) || null,
    }));
  }

  /** The visible slider with this code (the store's own wins) and its active slides. */
  async slider(
    ctx: StoreContext,
    code: string,
  ): Promise<StorefrontSliderDto | undefined> {
    const rows = await this.prisma.slider.findMany({
      where: { code, ...live(ctx, new Date()) },
      select: {
        id: true,
        code: true,
        storeId: true,
        autoplayMs: true,
        slides: {
          where: { isActive: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            imageId: true,
            linkUrl: true,
            translations: {
              where: { localeCode: { in: ctx.localeChain } },
              select: {
                localeCode: true,
                title: true,
                caption: true,
                ctaLabel: true,
              },
            },
          },
        },
      },
    });
    const s = rows.find((r) => r.storeId) ?? rows[0];
    if (!s) return undefined;
    const images = await this.media.imagesById(
      s.slides.map((x) => x.imageId),
      ctx.localeChain,
    );
    return {
      id: s.id,
      code: s.code,
      autoplayMs: s.autoplayMs,
      slides: s.slides.map((x) => {
        const t = pickTranslation(x.translations, ctx.localeChain);
        return {
          id: x.id,
          title: t?.title ?? null,
          caption: t?.caption ?? null,
          ctaLabel: t?.ctaLabel ?? null,
          linkUrl: x.linkUrl,
          image: (x.imageId && images.get(x.imageId)) || null,
        };
      }),
    };
  }
}
