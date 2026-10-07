import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { EntityEvent } from '../../common/events/entity.events.js';
import {
  CUSTOMER_EVENTS,
  type CustomerEventData,
} from '../customers/customers.events.js';
import { LoyaltyService } from './loyalty.service.js';

const AFTER = { async: true, promisify: true } as const;

/** New accounts join their website's loyalty program. */
@Injectable()
export class LoyaltyListener {
  constructor(private readonly loyalty: LoyaltyService) {}

  @OnEvent(CUSTOMER_EVENTS.REGISTERED, AFTER)
  async onRegistered(e: EntityEvent<CustomerEventData>) {
    await this.loyalty.openAccount(e.data.customerId);
  }

  @OnEvent(CUSTOMER_EVENTS.CREATED, AFTER)
  async onCreated(e: EntityEvent<CustomerEventData>) {
    await this.loyalty.openAccount(e.data.customerId);
  }
}
