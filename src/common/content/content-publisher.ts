import { Injectable, NotFoundException } from '@nestjs/common';
import {
  actorOf,
  type ActorRef,
  type Principal,
  SYSTEM_ACTOR,
} from '../auth/principal.js';
import type { AfterEvents } from '../events/base.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../events/entity.events.js';
import { TransactionalEventBus } from '../events/transactional-event-bus.js';
import type {
  ContentType,
  ScheduleAction,
} from '../../database/generated/prisma/client.js';
import type { PrismaTransaction } from '../../database/prisma.service.js';
import {
  applyDue,
  CONTENT_SCHEDULE_EVENTS,
  isVisible,
  LIVE_STATUSES,
  planPublish,
  planUnpublish,
  type PublishState,
  type ScheduleRequestedData,
  schedulesFor,
} from './publishing.js';

export type ContentModel =
  'page' | 'post' | 'block' | 'banner' | 'slider' | 'campaign' | 'promotion';

export const CONTENT_TYPE: Record<ContentModel, ContentType> = {
  page: 'PAGE',
  post: 'POST',
  block: 'BLOCK',
  banner: 'BANNER',
  slider: 'SLIDER',
  campaign: 'CAMPAIGN',
  promotion: 'PROMOTION',
};

/** Models without a store scope (their rows have no `store_id`). */
const UNSCOPED: ReadonlySet<ContentModel> = new Set(['campaign', 'promotion']);

/** Event names a publishable entity emits (see `publishingEvents`). */
export interface PublishingEvents {
  BEFORE_WRITE: string;
  PUBLISHED: string;
  UNPUBLISHED: string;
  SCHEDULED: string;
}

export function publishingEvents(entity: string) {
  return {
    PUBLISHED: `${entity}.published`,
    UNPUBLISHED: `${entity}.unpublished`,
    /** Publish or unpublish time set/changed without changing what is shown now. */
    SCHEDULED: `${entity}.scheduled`,
  } as const;
}

/** Data of publishing events (plain JSON). */
export interface ContentStateEventData {
  id: string;
  storeId: string | null;
  status: PublishState['status'];
  publishedAt: string | null;
  unpublishedAt: string | null;
  visible: boolean;
}

interface Row extends PublishState {
  storeId?: string | null;
}

interface Delegate {
  findUnique(args: {
    where: { id: string };
    select: Record<string, true>;
  }): Promise<Row | null>;
  update(args: { where: { id: string }; data: PublishState }): Promise<unknown>;
}

const stateSelect = (model: ContentModel): Record<string, true> => ({
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  ...(UNSCOPED.has(model) ? {} : { storeId: true }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Publish / unpublish / due-schedule transitions for every content model, through the
 * transactional write path. Emits an audited `<entity>.published|unpublished|scheduled` event and
 * asks the scheduler to mirror the new state.
 */
@Injectable()
export class ContentPublisher {
  constructor(private readonly bus: TransactionalEventBus) {}

  change(
    model: ContentModel,
    id: string,
    events: PublishingEvents,
    action: 'publish' | 'unpublish',
    at: Date | undefined,
    actor: Principal | undefined,
    now = new Date(),
  ): Promise<PublishState> {
    const ref = actorOf(actor);
    return this.bus.write({
      before: new BeforeWriteEvent(events.BEFORE_WRITE, action, id, ref, {
        at: iso(at ?? null),
      }),
      work: async (tx, after) => {
        const d = delegate(tx, model);
        const cur = await d.findUnique({
          where: { id },
          select: stateSelect(model),
        });
        if (!cur)
          throw new NotFoundException(`${label(model)} ${id} not found`);
        const next =
          action === 'publish'
            ? planPublish(cur, at, now)
            : planUnpublish(cur, at, now);
        if (sameState(cur, next)) return next;
        await d.update({ where: { id }, data: next });
        this.announce(after, model, id, cur, next, events, ref, now);
        return next;
      },
    });
  }

  /** A due schedule of the owner's model; no-op when the state no longer calls for it. */
  async due(
    model: ContentModel,
    id: string,
    action: ScheduleAction,
    events: PublishingEvents,
    now = new Date(),
  ): Promise<boolean> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        events.BEFORE_WRITE,
        `scheduled-${action.toLowerCase()}`,
        id,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        const d = delegate(tx, model);
        const cur = await d.findUnique({
          where: { id },
          select: stateSelect(model),
        });
        const next = cur && applyDue(cur, action, now);
        if (!cur || !next) return false;
        await d.update({ where: { id }, data: next });
        this.announce(after, model, id, cur, next, events, SYSTEM_ACTOR, now);
        return true;
      },
    });
  }

  /** Inside a delete: drop the target's pending schedules. */
  cancelSchedules(after: AfterEvents, model: ContentModel, id: string): void {
    after.add(
      new ProjectionEvent<ScheduleRequestedData>(
        CONTENT_SCHEDULE_EVENTS.REQUESTED,
        {
          requests: schedulesFor(
            CONTENT_TYPE[model],
            id,
            { status: 'DRAFT', publishedAt: null, unpublishedAt: null },
            new Date(),
          ),
          actorId: null,
        },
      ),
    );
  }

  private announce(
    after: AfterEvents,
    model: ContentModel,
    id: string,
    cur: Row,
    next: PublishState,
    events: PublishingEvents,
    actor: ActorRef,
    now: Date,
  ): void {
    // Named by status (what editors and listeners care about): visibility may already have
    // changed by the clock when a due schedule is applied.
    const name =
      next.status === 'PUBLISHED' && cur.status !== 'PUBLISHED'
        ? events.PUBLISHED
        : LIVE_STATUSES.includes(cur.status) &&
            !LIVE_STATUSES.includes(next.status)
          ? events.UNPUBLISHED
          : events.SCHEDULED;
    const is = isVisible(next, now);
    after.add(
      new EntityEvent<ContentStateEventData>(
        name,
        actor,
        model,
        id,
        {
          status: { from: cur.status, to: next.status },
          publishedAt: {
            from: iso(cur.publishedAt),
            to: iso(next.publishedAt),
          },
          unpublishedAt: {
            from: iso(cur.unpublishedAt),
            to: iso(next.unpublishedAt),
          },
        },
        {
          id,
          storeId: cur.storeId ?? null,
          status: next.status,
          publishedAt: iso(next.publishedAt),
          unpublishedAt: iso(next.unpublishedAt),
          visible: is,
        },
      ),
    );
    after.add(
      new ProjectionEvent<ScheduleRequestedData>(
        CONTENT_SCHEDULE_EVENTS.REQUESTED,
        {
          requests: schedulesFor(CONTENT_TYPE[model], id, next, now),
          actorId: actor.type === 'admin' ? actor.id : null,
        },
      ),
    );
  }
}

function delegate(tx: PrismaTransaction, model: ContentModel): Delegate {
  return (tx as unknown as Record<ContentModel, Delegate>)[model];
}

function label(model: ContentModel): string {
  return model[0].toUpperCase() + model.slice(1);
}

function sameState(a: PublishState, b: PublishState): boolean {
  return (
    a.status === b.status &&
    a.publishedAt?.getTime() === b.publishedAt?.getTime() &&
    a.unpublishedAt?.getTime() === b.unpublishedAt?.getTime()
  );
}
