import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import sharp from 'sharp';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { originalKey, renditionKey, renditionWidths } from './image-keys.js';
import { ImagesService, inspectImage } from './images.service.js';
import { MediaListener } from './media.listener.js';
import { MediaProcessor } from './media.processor.js';
import { MediaQuery } from './media.query.js';

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
const config = (publicBaseUrl?: string) => ({
  get: () => ({ maxUploadBytes: 1024 * 1024, publicBaseUrl }),
});
const storage = () => ({
  putObject: vi.fn(
    async (_key: string, _body: Buffer, _mime: string, _cache?: string) =>
      undefined,
  ),
  getObject: vi.fn(async () => Buffer.alloc(0)),
  getSignedUrl: vi.fn(async (k: string) => `https://signed/${k}?sig`),
  deleteObjects: vi.fn(async (keys: string[]) => ({
    deleted: keys,
    failed: [] as string[],
  })),
});
const imageRow = (o: object = {}) => ({
  id: 'i1',
  storageKey: 'catalog/images/ab/abc.png',
  checksum: 'abc',
  mime: 'image/png',
  width: 800,
  height: 600,
  bytes: 100,
  originalFilename: 'a.png',
  renditions: { '200': { key: 'r200', width: 200, height: 150 } },
  createdAt: new Date(),
  translations: [],
  _count: { links: 0 },
  ...o,
});

describe('image keys', () => {
  it('are content addressed and never upscale', () => {
    expect(originalKey('abcdef', 'jpeg')).toBe('catalog/images/ab/abcdef.jpg');
    expect(renditionKey('abcdef', 600)).toBe(
      'catalog/images/ab/abcdef/w600.webp',
    );
    expect(renditionWidths(1600)).toEqual([200, 600, 1200]);
    expect(renditionWidths(700)).toEqual([200, 600]);
    expect(renditionWidths(120)).toEqual([120]);
  });
});

describe('inspectImage', () => {
  it('reads format and size from the bytes', async () => {
    expect(await inspectImage(await png(30, 20))).toEqual({
      format: 'png',
      width: 30,
      height: 20,
    });
  });
  it('rejects non-images and unsupported formats', async () => {
    await expect(inspectImage(Buffer.from('hello'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const tiff = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .tiff()
      .toBuffer();
    await expect(inspectImage(tiff)).rejects.toThrow(
      'Unsupported image format tiff',
    );
  });
});

describe('ImagesService', () => {
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    const s = storage();
    return {
      svc: new ImagesService(
        prisma as never,
        fb.bus,
        s as never,
        config() as never,
      ),
      prisma,
      storage: s,
      ...fb,
    };
  }

  it('uploads once per content, under a deterministic key, then records it', async () => {
    const { svc, prisma, storage, afterNames } = setup();
    const buffer = await png(40, 30);
    prisma.image.create.mockResolvedValue(imageRow());
    await svc.upload(
      { buffer, size: buffer.length, originalname: 'a.png' },
      { localeCode: 'en-US', alt: 'Alt' },
      ROOT,
    );
    const [key, , mime, cache] = storage.putObject.mock.calls[0];
    expect(key).toMatch(/^catalog\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect([mime, cache]).toEqual([
      'image/png',
      'public, max-age=31536000, immutable',
    ]);
    expect(prisma.image.create.mock.calls[0][0].data).toMatchObject({
      width: 40,
      height: 30,
      translations: { create: [{ localeCode: 'en-US', alt: 'Alt' }] },
      createdById: ROOT.id,
    });
    expect(afterNames()).toEqual(['image.created']);
    prisma.image.findUnique.mockResolvedValue(imageRow());
    expect(
      (await svc.upload({ buffer, size: buffer.length }, {}, ROOT)).id,
    ).toBe('i1');
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });

  it('rejects missing files, oversize files and alt without locale', async () => {
    const { svc } = setup();
    await expect(svc.upload(undefined, {}, ROOT)).rejects.toThrow(
      'multipart field "file"',
    );
    await expect(
      svc.upload({ buffer: Buffer.alloc(10), size: 2 * 1024 * 1024 }, {}, ROOT),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(
      svc.upload({ buffer: Buffer.alloc(10), size: 10 }, { alt: 'x' }, ROOT),
    ).rejects.toThrow('localeCode is required');
  });

  it('updates alts, deletes (force for linked images) and lists', async () => {
    const { svc, prisma, after } = setup();
    prisma.image.findUnique.mockResolvedValue(
      imageRow({ _count: { links: 2 } }),
    );
    prisma.image.findUniqueOrThrow.mockResolvedValue(
      imageRow({ translations: [{ localeCode: 'en-US', alt: 'A' }] }),
    );
    expect(
      (
        await svc.update(
          'i1',
          { alts: [{ localeCode: 'en-US', alt: 'A' }] },
          ROOT,
        )
      ).alts,
    ).toEqual([{ localeCode: 'en-US', alt: 'A' }]);
    await expect(svc.remove('i1', false, ROOT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await svc.remove('i1', true, ROOT);
    expect(after[1]).toMatchObject({
      name: 'image.deleted',
      data: { keys: ['catalog/images/ab/abc.png', 'r200'] },
    });
    prisma.image.findUnique.mockResolvedValue(null);
    await expect(svc.remove('x', true, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.update('x', { alts: [] }, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.get('x')).rejects.toBeInstanceOf(NotFoundException);
    prisma.image.findMany.mockResolvedValue([imageRow()]);
    prisma.image.count.mockResolvedValue(1);
    expect(
      (
        await svc.list({
          page: 1,
          limit: 10,
          skip: 0,
          order: 'desc',
          search: 'a',
        } as never)
      ).data[0].renditions,
    ).toEqual([{ key: 'r200', width: 200, height: 150 }]);
  });

  it('replaces links after the owner check, with role rules', async () => {
    const { svc, prisma, before, afterNames } = setup();
    await expect(
      svc.setLinks(
        'PRODUCT',
        'p',
        {
          images: [
            { imageId: 'i', role: 'BASE' },
            { imageId: 'i', role: 'BASE' },
          ],
        },
        ROOT,
      ),
    ).rejects.toThrow('twice');
    await expect(
      svc.setLinks(
        'PRODUCT',
        'p',
        {
          images: [
            { imageId: 'a', role: 'BASE' },
            { imageId: 'b', role: 'BASE' },
          ],
        },
        ROOT,
      ),
    ).rejects.toThrow('Only one BASE');
    await expect(
      svc.setLinks(
        'PRODUCT',
        'p',
        { images: [{ imageId: 'a', role: 'GALLERY' }] },
        ROOT,
      ),
    ).rejects.toThrow('do not exist');
    prisma.image.count.mockResolvedValue(2);
    prisma.imageLink.findMany.mockResolvedValue([
      { imageId: 'a', role: 'BASE', position: 0 },
    ]);
    await svc.setLinks(
      'PRODUCT',
      'p',
      {
        images: [
          { imageId: 'a', role: 'BASE' },
          { imageId: 'b', role: 'GALLERY', position: 5 },
        ],
      },
      ROOT,
    );
    expect(prisma.imageLink.createMany).toHaveBeenCalledWith({
      data: [
        {
          ownerType: 'PRODUCT',
          ownerId: 'p',
          imageId: 'a',
          role: 'BASE',
          position: 0,
        },
        {
          ownerType: 'PRODUCT',
          ownerId: 'p',
          imageId: 'b',
          role: 'GALLERY',
          position: 5,
        },
      ],
    });
    expect(before.at(-1)).toMatchObject({
      name: 'image-links.before-write',
      action: 'set',
      input: { ownerType: 'PRODUCT', ownerId: 'p' },
    });
    expect(afterNames()).toEqual(['image-links.changed']);
  });

  it('owner cleanup and renditions are projections', async () => {
    const { svc, prisma, afterNames } = setup();
    prisma.imageLink.deleteMany.mockResolvedValue({ count: 2 });
    await svc.removeOwnerLinks('VARIANT', 'v');
    prisma.image.updateMany.mockResolvedValue({ count: 1 });
    await svc.setRenditions('i1', [{ key: 'k', width: 200, height: 100 }]);
    expect(prisma.image.updateMany.mock.calls[0][0].data).toEqual({
      renditions: { '200': { key: 'k', width: 200, height: 100 } },
    });
    expect(afterNames()).toEqual([
      'image-links.changed',
      'image.renditions-ready',
    ]);
  });
});

describe('MediaProcessor', () => {
  it('renders WebP renditions and records them', async () => {
    const prisma = fakePrisma();
    const s = storage();
    s.getObject.mockResolvedValue(await png(700, 350));
    prisma.image.findUnique.mockResolvedValue({
      storageKey: 'k',
      checksum: 'abcdef',
      width: 700,
    });
    const images = { setRenditions: vi.fn(async () => undefined) };
    const p = new MediaProcessor(prisma as never, s as never, images as never);
    expect(
      await p.process({
        id: '1',
        name: 'image-renditions',
        data: { imageId: 'i1' },
      } as never),
    ).toEqual({ renditions: 2 });
    expect(s.putObject.mock.calls.map((c) => c[0])).toEqual([
      'catalog/images/ab/abcdef/w200.webp',
      'catalog/images/ab/abcdef/w600.webp',
    ]);
    expect(images.setRenditions).toHaveBeenCalledWith('i1', [
      { key: 'catalog/images/ab/abcdef/w200.webp', width: 200, height: 100 },
      { key: 'catalog/images/ab/abcdef/w600.webp', width: 600, height: 300 },
    ]);
    prisma.image.findUnique.mockResolvedValue(null);
    expect(await p.renditions('gone')).toBe(0);
    expect(
      await p.process({ id: '2', name: 'other', data: {} } as never),
    ).toEqual({ skipped: 'unknown job other' });
  });
});

describe('MediaListener', () => {
  it('queues renditions once, deletes objects, and cleans links of deleted owners', async () => {
    const queue = {
      add: vi.fn(
        async (_name: string, _data: object, _opts: object) => undefined,
      ),
    };
    const s = storage();
    s.deleteObjects.mockResolvedValueOnce({ deleted: [], failed: ['k'] });
    const images = { removeOwnerLinks: vi.fn(async () => undefined) };
    const l = new MediaListener(queue as never, s as never, images as never);
    await l.onImageCreated({ data: { imageId: 'i1' } } as never);
    expect(queue.add).toHaveBeenCalledWith(
      'image-renditions',
      { imageId: 'i1' },
      expect.objectContaining({ jobId: 'renditions-i1' }),
    );
    await l.onImageDeleted({ data: { imageId: 'i1', keys: ['k'] } } as never);
    await l.onImageDeleted({ data: { imageId: 'i1' } } as never);
    expect(s.deleteObjects).toHaveBeenCalledTimes(1);
    await l.onVariantDeleted({
      data: { productId: 'p', variantId: 'v' },
    } as never);
    await l.onVariantDeleted({ data: { productId: 'p' } } as never);
    await l.onCategoryDeleted({ data: { categoryId: 'c' } } as never);
    expect(images.removeOwnerLinks.mock.calls).toEqual([
      ['VARIANT', 'v'],
      ['CATEGORY', 'c'],
    ]);
  });
});

describe('MediaQuery', () => {
  it('returns ordered images with CDN or signed URLs and localized alts', async () => {
    const prisma = fakePrisma();
    prisma.imageLink.findMany.mockResolvedValue([
      {
        ownerId: 'p',
        role: 'BASE',
        position: 0,
        image: {
          id: 'i',
          storageKey: 'k',
          width: 800,
          height: 600,
          renditions: {
            '600': { key: 'r6', width: 600, height: 450 },
            '200': { key: 'r2', width: 200, height: 150 },
          },
          translations: [{ localeCode: 'en-US', alt: 'A' }],
        },
      },
    ]);
    const cdn = new MediaQuery(
      prisma as never,
      storage() as never,
      config('https://cdn.example') as never,
    );
    const out = (
      await cdn.imagesFor('PRODUCT', ['p', 'q'], ['vi-VN', 'en-US'])
    ).get('p')!;
    expect(out[0]).toMatchObject({
      url: 'https://cdn.example/k',
      alt: 'A',
      renditions: [
        { width: 200, url: 'https://cdn.example/r2' },
        { width: 600, url: 'https://cdn.example/r6' },
      ],
    });
    const signed = new MediaQuery(
      prisma as never,
      storage() as never,
      config() as never,
    );
    expect(
      (await signed.imagesFor('PRODUCT', ['p'], ['en-US'])).get('p')![0].url,
    ).toBe('https://signed/k?sig');
    expect(await signed.imagesFor('PRODUCT', [], ['en-US'])).toEqual(new Map());
  });

  it('images by id for content (banners, slides), deduplicated', async () => {
    const prisma = fakePrisma();
    const q = new MediaQuery(
      prisma as never,
      storage() as never,
      config('https://cdn.example') as never,
    );
    expect(await q.imagesById([null, undefined], ['en-US'])).toEqual(new Map());
    prisma.image.findMany.mockResolvedValueOnce([
      {
        id: 'i',
        storageKey: 'k',
        width: 10,
        height: 5,
        renditions: {
          b: { width: 600, key: 'r6' },
          a: { width: 300, key: 'r3' },
        },
        translations: [{ localeCode: 'en-US', alt: 'Alt' }],
      },
      {
        id: 'j',
        storageKey: 'k2',
        width: 1,
        height: 1,
        renditions: null,
        translations: [],
      },
    ]);
    const out = await q.imagesById(['i', 'i', 'j', null], ['en-US']);
    expect(prisma.image.findMany.mock.calls[0][0].where.id.in).toEqual([
      'i',
      'j',
    ]);
    expect(out.get('i')).toEqual({
      url: 'https://cdn.example/k',
      width: 10,
      height: 5,
      alt: 'Alt',
      renditions: [
        { width: 300, height: undefined, url: 'https://cdn.example/r3' },
        { width: 600, height: undefined, url: 'https://cdn.example/r6' },
      ],
    });
    expect(out.get('j')).toMatchObject({ alt: null, renditions: [] });
  });
});
