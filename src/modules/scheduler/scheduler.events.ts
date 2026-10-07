import { entityEvents } from '../../common/events/entity.events.js';

export const SCHEDULE_EVENTS = {
  BEFORE_WRITE: entityEvents('schedule').BEFORE_WRITE,
  /** Pending schedules were set or cancelled (projection; not audited — the content change is). */
  CHANGED: 'schedule.changed',
} as const;
