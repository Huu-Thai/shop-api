import { entityEvents } from '../../common/events/entity.events.js';

export const ATTRIBUTE_EVENTS = entityEvents('attribute');
export const ATTRIBUTE_SET_EVENTS = entityEvents('attribute-set');
export const CATEGORY_EVENTS = {
  ...entityEvents('category'),
  MOVED: 'category.moved',
} as const;

/** `attribute.before-write` input: lets the products module veto removing options in use. */
export interface AttributeWriteInput {
  code: string;
  removedOptionCodes: string[];
}

/** Data on category after-events (URL rewrites rebuild the category and its subtree). */
export interface CategoryEventData {
  categoryId: string;
  /** The category's path before a move/delete, so the old subtree can be found. */
  path: string;
  /** Slugs, website assignment or parent changed: URLs of the subtree must be rebuilt. */
  urlsChanged: boolean;
}

/** `category.before-write` input: the slugs about to be written, per locale. */
export interface CategoryWriteInput {
  parentId: string | null;
  slugs: { localeCode: string; slug: string }[];
}
