import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TAX_CLASS_EVENTS, TAX_CHANGED_EVENTS } from './tax.events.js';
import { TaxQuery } from './tax.query.js';

const AFTER = { async: true, promisify: true } as const;

/** Tax configuration changed → every process reloads its TaxQuery snapshot. */
@Injectable()
export class TaxCacheListener {
  constructor(private readonly tax: TaxQuery) {}

  @OnEvent(TAX_CHANGED_EVENTS[0], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[1], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[2], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[3], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[4], AFTER)
  @OnEvent(TAX_CHANGED_EVENTS[5], AFTER)
  @OnEvent(TAX_CLASS_EVENTS.CREATED, AFTER)
  @OnEvent(TAX_CLASS_EVENTS.DELETED, AFTER)
  async onTaxChanged(): Promise<void> {
    await this.tax.invalidate();
  }
}
