import { publishingEvents } from '../../common/content/content-publisher.js';
import { entityEvents } from '../../common/events/entity.events.js';

export const PAGE_EVENTS = {
  ...entityEvents('page'),
  ...publishingEvents('page'),
} as const;
export const POST_EVENTS = {
  ...entityEvents('post'),
  ...publishingEvents('post'),
} as const;
export const TAG_EVENTS = entityEvents('tag');
export const BLOCK_EVENTS = {
  ...entityEvents('block'),
  ...publishingEvents('block'),
} as const;
export const BLOCK_PLACEMENT_EVENTS = entityEvents('block-placement');

/** Before-write input of pages and posts: the URL veto checks the slugs. */
export interface ContentWriteInput {
  storeId: string | null;
  slugs: { localeCode: string; slug: string }[];
}

/** Data of page/post created/updated/deleted events (plain JSON). */
export interface ContentEventData {
  id: string;
  storeId: string | null;
  /** Slugs before the change (URL rebuilds release them). */
  previousSlugs: string[];
}

/** Placement target kinds, for cleanup on deletion. */
export interface PlacementEventData {
  blockId: string;
  targetType: string;
  targetId: string;
  region: string;
}
