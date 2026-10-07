import { NotFoundException } from '@nestjs/common';
import { exerciseController, stubService } from '../../testing/controllers.js';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { BannersService } from './banners.service.js';
import {
  BannersController,
  SlidersController,
  StorefrontBannersController,
  StorefrontSlidersController,
} from './merchandising.controllers.js';
import { MerchandisingListener } from './merchandising.listener.js';
import { MerchandisingQuery } from './merchandising.query.js';
import { SlidersService } from './sliders.service.js';

const q = (extra: object = {}) =>
  ({ page: 1, limit: 25, order: 'desc', skip: 0, ...extra }) as never;
const en = (fields: object) => [{ localeCode: 'en-US', ...fields }];

function base() {
  const prisma = fakePrisma();
  const fb = fakeBus(prisma);
  const publisher = {
    change: vi.fn(async (..._a: unknown[]) => undefined),
    cancelSchedules: vi.fn(),
  };
  return { prisma, publisher, ...fb };
}

const bannerRow = (over: object = {}) => ({
  id: 'b',
  placement: 'home.hero',
  name: 'Hero',
  storeId: null,
  status: 'DRAFT',
  publishedAt: null,
  unpublishedAt: null,
  position: 0,
  linkUrl: null,
  imageId: null,
  translations: [],
  ...over,
});

describe('BannersService', () => {
  it('CRUD and publishing', async () => {
    const { prisma, bus, publisher, afterNames } = base();
    const svc = new BannersService(prisma as never, bus, publisher as never);
    prisma.banner.create.mockResolvedValue(bannerRow());
    await svc.create(
      {
        placement: 'home.hero',
        name: 'Hero',
        translations: [{ localeCode: 'en-US', title: 'Sale', imageId: 'i' }],
      },
      ROOT,
    );
    expect(
      prisma.banner.create.mock.calls[0][0].data.translations.create[0],
    ).toEqual({
      localeCode: 'en-US',
      title: 'Sale',
      subtitle: null,
      ctaLabel: null,
      imageId: 'i',
    });
    await svc.create({ placement: 'p', name: 'n' }, ROOT);
    prisma.banner.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('b', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.banner.findUnique.mockResolvedValue(bannerRow());
    prisma.banner.update
      .mockResolvedValueOnce(bannerRow({ name: 'New' }))
      .mockResolvedValueOnce(bannerRow());
    await svc.update(
      'b',
      {
        name: 'New',
        translations: [{ localeCode: 'en-US', ctaLabel: 'Go' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    await svc.update('b', {}, ROOT);
    prisma.banner.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('b', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.remove('b', ROOT);
    expect(publisher.cancelSchedules).toHaveBeenCalled();
    expect(afterNames()).toEqual([
      'banner.created',
      'banner.created',
      'banner.updated',
      'banner.deleted',
    ]);
    prisma.banner.findMany.mockResolvedValue([bannerRow()]);
    await svc.list(
      q({ storeId: 'global', placement: 'home.hero', search: 'x' }),
    );
    await svc.list(q());
    prisma.banner.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('b')).rejects.toBeInstanceOf(NotFoundException);
    await svc.publish('b', 'publish', '2026-11-01T00:00:00Z', ROOT);
    await svc.publish('b', 'unpublish', undefined, ROOT);
    expect(publisher.change).toHaveBeenCalledTimes(2);
  });
});

const sliderRow = (over: object = {}) => ({
  id: 's',
  code: 'home',
  name: 'Home',
  storeId: null,
  status: 'DRAFT',
  publishedAt: null,
  unpublishedAt: null,
  autoplayMs: null,
  slides: [],
  ...over,
});

describe('SlidersService', () => {
  it('sliders and slides', async () => {
    const { prisma, bus, publisher, afterNames } = base();
    const svc = new SlidersService(prisma as never, bus, publisher as never);
    prisma.slider.create.mockResolvedValue(sliderRow());
    await svc.create({ code: 'home', name: 'Home', autoplayMs: 3000 }, ROOT);
    await svc.create({ code: 'x', name: 'X' }, ROOT);
    prisma.slider.findUnique.mockResolvedValueOnce(null);
    await expect(svc.update('s', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.slider.findUnique.mockResolvedValue(sliderRow());
    prisma.slider.update
      .mockResolvedValueOnce(sliderRow({ autoplayMs: 4000 }))
      .mockResolvedValueOnce(sliderRow());
    await svc.update('s', { autoplayMs: 4000 }, ROOT);
    await svc.update('s', {}, ROOT);
    prisma.slider.findUnique.mockResolvedValueOnce(null);
    await expect(svc.remove('s', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await svc.remove('s', ROOT);
    prisma.slider.findMany.mockResolvedValue([sliderRow()]);
    await svc.list(q({ storeId: 'global', search: 'H' }));
    await svc.list(q());
    prisma.slider.findUnique.mockResolvedValueOnce(null);
    await expect(svc.get('s')).rejects.toBeInstanceOf(NotFoundException);
    await svc.publish('s', 'publish', undefined, ROOT);
    await svc.publish('s', 'unpublish', '2026-11-01T00:00:00Z', ROOT);

    prisma.slider.findUnique.mockResolvedValueOnce(null);
    await expect(svc.addSlide('s', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.slide.create.mockResolvedValue({ id: 'sl' });
    await svc.addSlide(
      's',
      { imageId: 'i', translations: [{ localeCode: 'en-US', caption: 'C' }] },
      ROOT,
    );
    await svc.addSlide('s', {}, ROOT);
    prisma.slide.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateSlide('sl', {}, ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const slide = {
      id: 'sl',
      imageId: null,
      position: 0,
      linkUrl: null,
      isActive: true,
      translations: [],
    };
    prisma.slide.findUnique.mockResolvedValue(slide);
    prisma.slide.update
      .mockResolvedValueOnce({ ...slide, isActive: false })
      .mockResolvedValueOnce(slide);
    await svc.updateSlide(
      'sl',
      {
        isActive: false,
        translations: [{ localeCode: 'en-US', title: 'T' }],
        removeLocales: ['vi-VN'],
      },
      ROOT,
    );
    await svc.updateSlide('sl', {}, ROOT);
    prisma.slide.findUnique.mockResolvedValueOnce(null);
    await expect(svc.removeSlide('sl', ROOT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.slide.findUnique.mockResolvedValueOnce({ sliderId: 's' });
    await svc.removeSlide('sl', ROOT);
    expect(afterNames()).toEqual([
      'slider.created',
      'slider.created',
      'slider.updated',
      'slider.deleted',
      'slide.created',
      'slide.created',
      'slide.updated',
      'slide.deleted',
    ]);
  });
});

describe('MerchandisingQuery', () => {
  const ctx = { storeId: 's1', localeChain: ['en-US'] } as StoreContext;

  it('banners use the localized artwork, then the banner image', async () => {
    const prisma = fakePrisma();
    const media = {
      imagesById: vi.fn(
        async () =>
          new Map([
            ['loc', { url: 'L' }],
            ['def', { url: 'D' }],
          ]),
      ),
    };
    const m = new MerchandisingQuery(prisma as never, media as never);
    prisma.banner.findMany.mockResolvedValueOnce([
      {
        id: '1',
        placement: 'p',
        linkUrl: '/a',
        imageId: 'def',
        translations: en({
          title: 'T',
          subtitle: null,
          ctaLabel: 'Go',
          imageId: 'loc',
        }),
      },
      {
        id: '2',
        placement: 'p',
        linkUrl: null,
        imageId: 'def',
        translations: [],
      },
      {
        id: '3',
        placement: 'p',
        linkUrl: null,
        imageId: null,
        translations: [],
      },
    ]);
    const out = await m.banners(ctx, 'p');
    expect(out.map((b) => [b.title, b.image?.url ?? null])).toEqual([
      ['T', 'L'],
      [null, 'D'],
      [null, null],
    ]);
  });

  it('sliders: the store’s own wins; slides localized', async () => {
    const prisma = fakePrisma();
    const media = {
      imagesById: vi.fn(async () => new Map([['i', { url: 'I' }]])),
    };
    const m = new MerchandisingQuery(prisma as never, media as never);
    prisma.slider.findMany.mockResolvedValueOnce([]);
    expect(await m.slider(ctx, 'home')).toBeUndefined();
    const slider = (id: string, storeId: string | null) => ({
      id,
      code: 'home',
      storeId,
      autoplayMs: null,
      slides: [
        {
          id: 'a',
          imageId: 'i',
          linkUrl: null,
          translations: en({ title: 'A', caption: null, ctaLabel: null }),
        },
        { id: 'b', imageId: null, linkUrl: '/b', translations: [] },
      ],
    });
    prisma.slider.findMany.mockResolvedValueOnce([
      slider('g', null),
      slider('l', 's1'),
    ]);
    const s = await m.slider(ctx, 'home');
    expect(s?.id).toBe('l');
    expect(s?.slides.map((x) => [x.title, x.image?.url ?? null])).toEqual([
      ['A', 'I'],
      [null, null],
    ]);
    prisma.slider.findMany.mockResolvedValueOnce([slider('g', null)]);
    expect((await m.slider(ctx, 'home'))?.id).toBe('g');
  });
});

describe('merchandising wiring', () => {
  it('applies due banner and slider schedules; controllers delegate', async () => {
    const publisher = { due: vi.fn() };
    const l = new MerchandisingListener(publisher as never);
    for (const targetType of ['BANNER', 'SLIDER', 'PAGE'])
      await l.onDue({
        data: { targetType, targetId: 't', action: 'UNPUBLISH' },
      } as never);
    expect(publisher.due.mock.calls.map((c) => c[0])).toEqual([
      'banner',
      'slider',
    ]);
    for (const C of [
      BannersController,
      SlidersController,
      StorefrontBannersController,
    ])
      expect(
        (await exerciseController(new C(stubService() as never))).failed,
      ).toBe(0);
    expect(
      (
        await exerciseController(
          new StorefrontSlidersController(stubService() as never),
        )
      ).failed,
    ).toBe(0);
    expect(
      (
        await exerciseController(
          new StorefrontSlidersController(stubService(undefined) as never),
        )
      ).failed,
    ).toBe(1);
  });
});
