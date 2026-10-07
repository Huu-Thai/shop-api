import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import type { AppConfig } from '../../config/configuration.js';
import type {
  ImageOwnerType,
  ImageRole,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { StorageService } from '../../storage/storage.service.js';
import type { Rendition } from './image-keys.js';

export interface ImageView {
  id: string;
  role: ImageRole;
  position: number;
  url: string;
  width: number;
  height: number;
  alt: string | null;
  renditions: { width: number; height: number; url: string }[];
}

export type ContentImageView = Omit<ImageView, 'id' | 'role' | 'position'>;

/** Images of storefront owners with public (CDN) or signed URLs and localized alt texts. */
@Injectable()
export class MediaQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Public URL when a CDN origin is configured, otherwise a short-lived signed URL. */
  url(key: string): Promise<string> {
    const base = this.config.get('media', { infer: true }).publicBaseUrl;
    return base
      ? Promise.resolve(`${base}/${key}`)
      : this.storage.getSignedUrl(key);
  }

  async imagesFor(
    ownerType: ImageOwnerType,
    ownerIds: readonly string[],
    chain: readonly string[],
  ): Promise<Map<string, ImageView[]>> {
    const out = new Map<string, ImageView[]>(ownerIds.map((id) => [id, []]));
    if (!ownerIds.length) return out;
    const links = await this.prisma.imageLink.findMany({
      where: { ownerType, ownerId: { in: [...ownerIds] } },
      orderBy: [{ position: 'asc' }, { role: 'asc' }],
      select: {
        ownerId: true,
        role: true,
        position: true,
        image: {
          select: {
            id: true,
            storageKey: true,
            width: true,
            height: true,
            renditions: true,
            translations: {
              where: { localeCode: { in: [...chain] } },
              select: { localeCode: true, alt: true },
            },
          },
        },
      },
    });
    for (const l of links) {
      const renditions = Object.values(
        (l.image.renditions ?? {}) as unknown as Record<string, Rendition>,
      ).sort((a, b) => a.width - b.width);
      out.get(l.ownerId)!.push({
        id: l.image.id,
        role: l.role,
        position: l.position,
        url: await this.url(l.image.storageKey),
        width: l.image.width,
        height: l.image.height,
        alt: pickTranslation(l.image.translations, chain)?.alt ?? null,
        renditions: await Promise.all(
          renditions.map(async (r) => ({
            width: r.width,
            height: r.height,
            url: await this.url(r.key),
          })),
        ),
      });
    }
    return out;
  }

  /** Images by id (banners, slides, featured images), with localized alt texts. */
  async imagesById(
    ids: readonly (string | null | undefined)[],
    chain: readonly string[],
  ): Promise<Map<string, ContentImageView>> {
    const wanted = [...new Set(ids.filter((i): i is string => !!i))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.image.findMany({
      where: { id: { in: wanted } },
      select: {
        id: true,
        storageKey: true,
        width: true,
        height: true,
        renditions: true,
        translations: {
          where: { localeCode: { in: [...chain] } },
          select: { localeCode: true, alt: true },
        },
      },
    });
    const out = new Map<string, ContentImageView>();
    for (const img of rows) {
      const renditions = Object.values(
        (img.renditions ?? {}) as unknown as Record<string, Rendition>,
      ).sort((a, b) => a.width - b.width);
      out.set(img.id, {
        url: await this.url(img.storageKey),
        width: img.width,
        height: img.height,
        alt: pickTranslation(img.translations, chain)?.alt ?? null,
        renditions: await Promise.all(
          renditions.map(async (r) => ({
            width: r.width,
            height: r.height,
            url: await this.url(r.key),
          })),
        ),
      });
    }
    return out;
  }
}
