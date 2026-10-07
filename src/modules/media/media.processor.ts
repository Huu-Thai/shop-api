import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import sharp from 'sharp';
import { withJobContext } from '../../common/utils/job-context.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type ImageRenditionsJob, JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  IMMUTABLE,
  type Rendition,
  renditionKey,
  renditionWidths,
} from './image-keys.js';
import { ImagesService, MAX_PIXELS } from './images.service.js';

/** Generates WebP renditions (auto-oriented, never upscaled) at content-addressed keys. */
@Processor(QUEUES.MEDIA, { concurrency: 2 })
export class MediaProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly images: ImagesService,
  ) {
    super();
  }

  process(job: Job<ImageRenditionsJob>) {
    return withJobContext(job, async () => {
      if (job.name !== JOBS.IMAGE_RENDITIONS)
        return { skipped: `unknown job ${job.name}` };
      return { renditions: await this.renditions(job.data.imageId) };
    });
  }

  async renditions(imageId: string): Promise<number> {
    const image = await this.prisma.image.findUnique({
      where: { id: imageId },
      select: { storageKey: true, checksum: true, width: true },
    });
    if (!image) return 0; // deleted meanwhile
    const original = await this.storage.getObject(image.storageKey);
    const out: Rendition[] = [];
    for (const width of renditionWidths(image.width)) {
      const { data, info } = await sharp(original, {
        limitInputPixels: MAX_PIXELS,
        animated: false,
      })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      const key = renditionKey(image.checksum, width);
      await this.storage.putObject(key, data, 'image/webp', IMMUTABLE);
      out.push({ key, width: info.width, height: info.height });
    }
    await this.images.setRenditions(imageId, out);
    this.logger.log(`Image ${imageId}: ${out.length} renditions`);
    return out.length;
  }
}
