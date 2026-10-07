/** Renditions generated for every image (CSS pixels, width); never upscaled. */
export const RENDITION_WIDTHS = [200, 600, 1200] as const;

export const ALLOWED_FORMATS = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
} as const;
export type ImageFormat = keyof typeof ALLOWED_FORMATS;
export const IMMUTABLE = 'public, max-age=31536000, immutable';

const EXT: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
};

/** Content-addressed keys: the same bytes always land on the same key (dedupe, safe retries). */
export const originalKey = (checksum: string, format: ImageFormat) =>
  `catalog/images/${checksum.slice(0, 2)}/${checksum}.${EXT[format]}`;
export const renditionKey = (checksum: string, width: number) =>
  `catalog/images/${checksum.slice(0, 2)}/${checksum}/w${width}.webp`;

/** Widths to generate for an image of `width` px (at least the smallest, never upscaled). */
export function renditionWidths(width: number): number[] {
  const ws = RENDITION_WIDTHS.filter((w) => w < width);
  return ws.length ? ws : [Math.min(width, RENDITION_WIDTHS[0])];
}

export interface Rendition {
  key: string;
  width: number;
  height: number;
}
