import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { STORE_CONFIG_EVENTS } from './stores.events.js';
import { StoresQuery } from './stores.query.js';

/** Store configuration changed → every process reloads its StoresQuery snapshot. */
@Injectable()
export class StoresCacheListener {
  constructor(private readonly stores: StoresQuery) {}

  // One handler per event (PLAN.md convention); all share the same reaction.
  @OnEvent(STORE_CONFIG_EVENTS[0], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[1], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[2], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[3], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[4], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[5], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[6], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[7], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[8], { async: true, promisify: true })
  @OnEvent(STORE_CONFIG_EVENTS[9], { async: true, promisify: true })
  async onStoreConfigChanged(): Promise<void> {
    await this.stores.invalidate();
  }
}
