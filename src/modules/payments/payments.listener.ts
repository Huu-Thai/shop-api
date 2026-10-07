import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { EntityEvent } from '../../common/events/entity.events.js';
import { ORDER_EVENTS, type OrderEventData } from '../orders/orders.events.js';
import { PaymentsService } from './payments.service.js';

const AFTER = { async: true, promisify: true } as const;

/** A cancelled order's open payment attempts are cancelled too. */
@Injectable()
export class PaymentsListener {
  constructor(private readonly payments: PaymentsService) {}

  @OnEvent(ORDER_EVENTS.CANCELED, AFTER)
  async onCanceled(e: EntityEvent<OrderEventData>) {
    await this.payments.cancelOpen(e.data.orderId);
  }
}
