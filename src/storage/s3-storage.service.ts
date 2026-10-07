import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { StorageService, type StoredObject } from './storage.service.js';

const DELETE_BATCH = 1000; // S3 DeleteObjects limit

@Injectable()
export class S3StorageService
  extends StorageService
  implements OnModuleDestroy
{
  readonly bucket: string;
  private readonly signedUrlTtl: number;
  private readonly sse?: 'AES256' | 'aws:kms';
  readonly client: S3Client;
  /** Signs links for browsers (the public endpoint, when the API talks to storage internally). */
  private readonly signer: S3Client;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    const s3 = config.get('s3', { infer: true });
    this.bucket = s3.bucket;
    this.signedUrlTtl = s3.signedUrlTtl;
    this.sse = s3.serverSideEncryption;
    const client = (endpoint?: string) =>
      new S3Client({
        region: s3.region,
        endpoint,
        forcePathStyle: s3.forcePathStyle,
        credentials: {
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
        },
      });
    this.client = client(s3.endpoint);
    this.signer = s3.publicEndpoint ? client(s3.publicEndpoint) : this.client;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
        ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  getSignedUrl(
    key: string,
    ttlSeconds = this.signedUrlTtl,
    downloadName?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(downloadName
          ? {
              ResponseContentDisposition: `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"`,
            }
          : {}),
      }),
      {
        expiresIn: ttlSeconds,
      },
    );
  }

  async deleteObjects(
    keys: string[],
  ): Promise<{ deleted: string[]; failed: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
        }),
      );
      deleted.push(...(res.Deleted ?? []).map((d) => d.Key!).filter(Boolean));
      failed.push(...(res.Errors ?? []).map((e) => e.Key!).filter(Boolean));
    }
    return { deleted, failed };
  }

  async *listObjects(
    prefix: string,
  ): AsyncGenerator<StoredObject[], void, undefined> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      const page = (res.Contents ?? [])
        .filter((o) => o.Key)
        .map((o) => ({
          key: o.Key!,
          lastModified: o.LastModified ?? new Date(0),
          size: o.Size ?? 0,
        }));
      if (page.length) yield page;
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }
}
