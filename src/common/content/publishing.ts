import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  ContentStatus,
  ContentType,
  ScheduleAction,
} from '../../database/generated/prisma/client.js';

/**
 * Publishing model shared by pages, posts, blocks, banners and sliders (PLAN.md §9 & §14 Phase 4).
 *
 * - `published_at` / `unpublished_at` define the visibility window; storefront reads check it
 *   against the clock (`visibleWhere`), so content appears and disappears on time even when the
 *   scheduler lags.
 * - The scheduler only moves the status forward (SCHEDULED → PUBLISHED → ARCHIVED) and announces
 *   it (`<entity>.published` / `.unpublished`) for URL, cache and audit listeners.
 * - Pending schedules mirror the state (`schedulesFor`), so a stale schedule is harmless: due
 *   actions re-check the current state (`applyDue`).
 */
export interface PublishState {
  status: ContentStatus;
  publishedAt: Date | null;
  unpublishedAt: Date | null;
}

/** Statuses on the publishing track: live now or going live at `published_at`. */
export const LIVE_STATUSES: readonly ContentStatus[] = [
  'PUBLISHED',
  'SCHEDULED',
];

export function isVisible(s: PublishState, now: Date): boolean {
  if (!LIVE_STATUSES.includes(s.status)) return false;
  if (s.publishedAt ? s.publishedAt > now : s.status !== 'PUBLISHED')
    return false;
  return !s.unpublishedAt || s.unpublishedAt > now;
}

/** Prisma `where` fragment equivalent to `isVisible` (works for every content model). */
export function visibleWhere(now: Date) {
  return {
    status: { in: [...LIVE_STATUSES] },
    AND: [
      {
        OR: [
          { publishedAt: { lte: now } },
          { publishedAt: null, status: 'PUBLISHED' as const },
        ],
      },
      { OR: [{ unpublishedAt: null }, { unpublishedAt: { gt: now } }] },
    ],
  };
}

/**
 * Publish now (`at` absent or not in the future) or schedule it. Republishing archived content
 * starts a new window; an existing future unpublish time is kept when it is still after the
 * publish time.
 */
export function planPublish(
  s: PublishState,
  at: Date | undefined,
  now: Date,
): PublishState {
  const future = !!at && at > now;
  const unpublishedAt =
    s.unpublishedAt && s.unpublishedAt > now ? s.unpublishedAt : null;
  if (future) {
    if (unpublishedAt && unpublishedAt <= at)
      throw new BadRequestException(
        'The publish time must be before the scheduled unpublish time',
      );
    return { status: 'SCHEDULED', publishedAt: at, unpublishedAt };
  }
  if (isVisible(s, now) && s.status === 'PUBLISHED') return s;
  return {
    status: 'PUBLISHED',
    // Content already live (a lagging SCHEDULED row too) keeps its publish time.
    publishedAt: isVisible(s, now) && s.publishedAt ? s.publishedAt : now,
    unpublishedAt,
  };
}

/**
 * Unpublish now or at a time. Content that never went live returns to DRAFT (its schedule is
 * cancelled); live content is ARCHIVED, keeping the time it ended.
 */
export function planUnpublish(
  s: PublishState,
  at: Date | undefined,
  now: Date,
): PublishState {
  if (!LIVE_STATUSES.includes(s.status))
    throw new ConflictException('The content is not published or scheduled');
  if (at && at > now) {
    if (s.publishedAt && at <= s.publishedAt)
      throw new BadRequestException(
        'The unpublish time must be after the publish time',
      );
    return { ...s, unpublishedAt: at };
  }
  if (!isVisible(s, now) && s.publishedAt && s.publishedAt > now)
    return { status: 'DRAFT', publishedAt: null, unpublishedAt: null };
  return {
    status: 'ARCHIVED',
    publishedAt: s.publishedAt,
    unpublishedAt: s.publishedAt && s.publishedAt < now ? now : null,
  };
}

/**
 * What a due schedule does to the current state; `null` when it no longer applies (the content
 * was changed after the schedule was made).
 */
export function applyDue(
  s: PublishState,
  action: ScheduleAction,
  now: Date,
): PublishState | null {
  if (action === 'PUBLISH')
    return s.status === 'SCHEDULED' && s.publishedAt && s.publishedAt <= now
      ? { ...s, status: 'PUBLISHED' }
      : null;
  return LIVE_STATUSES.includes(s.status) &&
    s.unpublishedAt &&
    s.unpublishedAt <= now
    ? { ...s, status: 'ARCHIVED' }
    : null;
}

export interface ScheduleRequest {
  targetType: ContentType;
  targetId: string;
  action: ScheduleAction;
  /** null cancels the pending schedule. */
  runAt: string | null;
}

/** The pending schedules a state implies (one entry per action; null = none). */
export function schedulesFor(
  targetType: ContentType,
  targetId: string,
  s: PublishState,
  now: Date,
): ScheduleRequest[] {
  const live = LIVE_STATUSES.includes(s.status);
  return [
    {
      targetType,
      targetId,
      action: 'PUBLISH',
      runAt:
        s.status === 'SCHEDULED' && s.publishedAt
          ? s.publishedAt.toISOString()
          : null,
    },
    {
      targetType,
      targetId,
      action: 'UNPUBLISH',
      runAt:
        live && s.unpublishedAt && s.unpublishedAt > now
          ? s.unpublishedAt.toISOString()
          : null,
    },
  ];
}

/** Events between content modules and the scheduler (plain JSON; redelivered by the outbox). */
export const CONTENT_SCHEDULE_EVENTS = {
  /** Owner → scheduler: set or cancel the pending schedules of a target. */
  REQUESTED: 'content.schedule-requested',
  /** Scheduler → owner: a schedule is due. */
  DUE: 'schedule.due',
} as const;

export interface ScheduleRequestedData {
  requests: ScheduleRequest[];
  actorId: string | null;
}

export interface ScheduleDueData {
  scheduleId: string;
  targetType: ContentType;
  targetId: string;
  action: ScheduleAction;
  runAt: string;
}
