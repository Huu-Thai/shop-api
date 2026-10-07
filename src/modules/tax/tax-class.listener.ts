import { BadRequestException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BeforeWriteEvent } from '../../common/events/entity.events.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  CUSTOMER_GROUP_EVENTS,
  type CustomerGroupWriteInput,
} from '../customers/customers.events.js';
import {
  PRODUCT_EVENTS,
  type ProductWriteInput,
} from '../products/products.events.js';

/** Before-listener (may veto): products need PRODUCT tax classes, customer groups CUSTOMER ones. */
@Injectable()
export class TaxClassUsageListener {
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(PRODUCT_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  async onProductWrite(
    event: BeforeWriteEvent<ProductWriteInput>,
  ): Promise<void> {
    await this.assertKind(event.input?.taxClassId, 'PRODUCT', 'taxClassId');
  }

  @OnEvent(CUSTOMER_GROUP_EVENTS.BEFORE_WRITE, { suppressErrors: false })
  async onCustomerGroupWrite(
    event: BeforeWriteEvent<CustomerGroupWriteInput>,
  ): Promise<void> {
    await this.assertKind(event.input?.taxClassId, 'CUSTOMER', 'taxClassId');
  }

  private async assertKind(
    id: string | null | undefined,
    type: 'PRODUCT' | 'CUSTOMER',
    field: string,
  ): Promise<void> {
    if (!id) return;
    const c = await this.prisma.taxClass.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!c)
      throw new BadRequestException(`${field}: tax class ${id} does not exist`);
    if (c.type !== type)
      throw new BadRequestException(`${field} must be a ${type} tax class`);
  }
}
