/** Every domain event carries its name and when it happened. Payloads hold ids, not rows. */
export abstract class BaseEvent {
  abstract readonly name: string;
  readonly occurredAt = new Date();
  /**
   * The outbox row id, set when the event is recorded after a write. Stable across redeliveries,
   * so consumers (audit log, outgoing webhooks) can process each event exactly once.
   */
  eventId?: string;
}

/** Collects after-commit events produced inside a transaction. */
export class AfterEvents {
  private readonly events: BaseEvent[] = [];

  add(event: BaseEvent): void {
    this.events.push(event);
  }

  drain(): BaseEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
