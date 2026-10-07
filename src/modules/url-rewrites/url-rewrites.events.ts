import { entityEvents } from '../../common/events/entity.events.js';

export const URL_REWRITE_EVENTS = {
  ...entityEvents('url-rewrite'),
  BEFORE_REBUILD: 'url-rewrites.before-rebuild',
  /** Projection changed for a target — CDN purge / sitemap listeners. */
  REBUILT: 'url-rewrites.rebuilt',
} as const;

export interface UrlRewritesRebuiltData {
  targetType: string;
  targetId: string;
  created: number;
  updated: number;
  deleted: number;
  collisions: number;
}
