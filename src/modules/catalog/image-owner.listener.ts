import { Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IMAGE_EVENTS,
  type ImageLinksWriteInput,
} from '../media/media.events.js';

/** Before-listener (may veto): category images need an existing category. */
@Injectable()
export class CategoryImageOwnerListener {
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(IMAGE_EVENTS.LINKS_BEFORE_WRITE, { suppressErrors: false })
  async onLinksWrite(
    event: BeforeWriteEvent<ImageLinksWriteInput>,
  ): Promise<void> {
    if (event.action !== 'set' || event.input?.ownerType !== 'CATEGORY') return;
    if (
      !(await this.prisma.category.count({
        where: { id: event.input.ownerId },
      }))
    )
      throw new NotFoundException(`Category ${event.input.ownerId} not found`);
  }
}
