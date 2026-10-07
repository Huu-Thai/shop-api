export interface StoredObject {
  key: string;
  lastModified: Date;
  size: number;
}

/** Object storage abstraction (PLAN.md §6b). S3StorageService is the only implementation. */
export abstract class StorageService {
  abstract readonly bucket: string;
  /** `cacheControl` for immutable, content-addressed keys (e.g. `public, max-age=31536000, immutable`). */
  abstract putObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void>;
  abstract getObject(key: string): Promise<Buffer>;
  /** `downloadName` makes browsers save the object under that file name. */
  abstract getSignedUrl(
    key: string,
    ttlSeconds?: number,
    downloadName?: string,
  ): Promise<string>;
  abstract deleteObjects(
    keys: string[],
  ): Promise<{ deleted: string[]; failed: string[] }>;
  /** Pages of objects under `prefix` (≤ 1000 per page), for the orphan sweep. */
  abstract listObjects(
    prefix: string,
  ): AsyncGenerator<StoredObject[], void, undefined>;
  abstract ping(): Promise<void>;
}
