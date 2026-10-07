import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import type { EntityEvent } from '../../common/events/entity.events.js';
import { type ImageRenditionsJob, JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  CATEGORY_EVENTS,
  type CategoryEventData,
} from '../catalog/catalog.events.js';
import {
  PRODUCT_EVENTS,
  type ProductEventData,
} from '../products/products.events.js';
import { ImagesService } from './images.service.js';
import { IMAGE_EVENTS, type ImageEventData } from './media.events.js';

/** After-listeners of the media module (idempotent: the outbox may redeliver). */
@Injectable()
export class MediaListener {
  private readonly logger = new Logger(MediaListener.name);

  constructor(
    @InjectQueue(QUEUES.MEDIA)
    private readonly queue: Queue<ImageRenditionsJob>,
    private readonly storage: StorageService,
    private readonly images: ImagesService,
  ) {}

  @OnEvent(IMAGE_EVENTS.CREATED, { async: true, promisify: true })
  async onImageCreated(event: EntityEvent<ImageEventData>): Promise<void> {
    const { imageId } = event.data;
    // Deterministic job id: a redelivered event doesn't render twice.
    await this.queue.add(
      JOBS.IMAGE_RENDITIONS,
      { imageId },
      {
        jobId: `renditions-${imageId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }

  @OnEvent(IMAGE_EVENTS.DELETED, { async: true, promisify: true })
  async onImageDeleted(event: EntityEvent<ImageEventData>): Promise<void> {
    const keys = event.data.keys ?? [];
    if (!keys.length) return;
    const { failed } = await this.storage.deleteObjects(keys);
    if (failed.length)
      this.logger.warn(
        `Could not delete ${failed.length} object(s) of image ${event.data.imageId}`,
      );
  }

  @OnEvent(PRODUCT_EVENTS.VARIANT_DELETED, { async: true, promisify: true })
  async onVariantDeleted(event: EntityEvent<ProductEventData>): Promise<void> {
    if (event.data.variantId)
      await this.images.removeOwnerLinks('VARIANT', event.data.variantId);
  }

  @OnEvent(CATEGORY_EVENTS.DELETED, { async: true, promisify: true })
  async onCategoryDeleted(
    event: EntityEvent<CategoryEventData>,
  ): Promise<void> {
    await this.images.removeOwnerLinks('CATEGORY', event.data.categoryId);
  }
}
