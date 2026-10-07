import { publishingEvents } from '../../common/content/content-publisher.js';
import { entityEvents } from '../../common/events/entity.events.js';

export const BANNER_EVENTS = {
  ...entityEvents('banner'),
  ...publishingEvents('banner'),
} as const;
export const SLIDER_EVENTS = {
  ...entityEvents('slider'),
  ...publishingEvents('slider'),
} as const;
export const SLIDE_EVENTS = entityEvents('slide');
