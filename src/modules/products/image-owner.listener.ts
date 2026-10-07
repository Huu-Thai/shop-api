import { Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IMAGE_EVENTS,
  type ImageLinksWriteInput,
} from '../media/media.events.js';

/** Before-listener (may veto): image links may only point at existing products and variants. */
@Injectable()
export class ProductImageOwnerListener {
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(IMAGE_EVENTS.LINKS_BEFORE_WRITE, { suppressErrors: false })
  async onLinksWrite(
    event: BeforeWriteEvent<ImageLinksWriteInput>,
  ): Promise<void> {
    if (event.action !== 'set' || !event.input) return;
    const { ownerType, ownerId } = event.input;
    if (ownerType === 'PRODUCT') {
      const p = await this.prisma.product.count({
        where: { id: ownerId, deletedAt: null },
      });
      if (!p) throw new NotFoundException(`Product ${ownerId} not found`);
    } else if (ownerType === 'VARIANT') {
      const v = await this.prisma.productVariant.count({
        where: { id: ownerId, product: { deletedAt: null } },
      });
      if (!v) throw new NotFoundException(`Variant ${ownerId} not found`);
    }
  }
}
