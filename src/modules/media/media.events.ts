import { entityEvents } from '../../common/events/entity.events.js';

export const IMAGE_EVENTS = {
  ...entityEvents('image'),
  LINKS_BEFORE_WRITE: 'image-links.before-write',
  LINKS_CHANGED: 'image-links.changed',
  RENDITIONS_READY: 'image.renditions-ready',
} as const;

export type ImageOwnerTypeName = 'PRODUCT' | 'VARIANT' | 'CATEGORY';

/** `image-links.before-write` input: owning modules veto links to owners that don't exist. */
export interface ImageLinksWriteInput {
  ownerType: ImageOwnerTypeName;
  ownerId: string;
}

export interface ImageEventData {
  imageId: string;
  /** Storage keys to remove after a delete (original + renditions). */
  keys?: string[];
}
