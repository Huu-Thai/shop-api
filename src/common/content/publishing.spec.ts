import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fakeBus } from '../../testing/fake-bus.js';
import { fakePrisma } from '../../testing/fake-prisma.js';
import { ROOT } from '../../testing/principals.js';
import { ContentPublisher, publishingEvents } from './content-publisher.js';
import {
  applyDue,
  isVisible,
  planPublish,
  planUnpublish,
  type PublishState,
  schedulesFor,
  visibleWhere,
} from './publishing.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const state = (
  status: PublishState['status'],
  publishedAt: Date | null = null,
  unpublishedAt: Date | null = null,
): PublishState => ({ status, publishedAt, unpublishedAt });

describe('publishing model', () => {
  it('visibility is decided by the window, not only the status', () => {
    expect(isVisible(state('DRAFT'), NOW)).toBe(false);
    expect(isVisible(state('ARCHIVED', at(-10)), NOW)).toBe(false);
    expect(isVisible(state('PUBLISHED'), NOW)).toBe(true);
    expect(isVisible(state('PUBLISHED', at(-1)), NOW)).toBe(true);
    expect(isVisible(state('SCHEDULED'), NOW)).toBe(false);
    expect(isVisible(state('SCHEDULED', at(5)), NOW)).toBe(false);
    // A lagging scheduler doesn't delay content.
    expect(isVisible(state('SCHEDULED', at(-1)), NOW)).toBe(true);
    expect(isVisible(state('PUBLISHED', at(-10), at(-1)), NOW)).toBe(false);
    expect(isVisible(state('PUBLISHED', at(-10), at(1)), NOW)).toBe(true);
    expect(visibleWhere(NOW).status.in).toEqual(['PUBLISHED', 'SCHEDULED']);
  });

  it('publish now, schedule, and keep the original publish time of live content', () => {
    expect(planPublish(state('DRAFT'), undefined, NOW)).toEqual(
      state('PUBLISHED', NOW),
    );
    expect(planPublish(state('DRAFT'), at(-5), NOW)).toEqual(
      state('PUBLISHED', NOW),
    );
    expect(planPublish(state('DRAFT'), at(30), NOW)).toEqual(
      state('SCHEDULED', at(30)),
    );
    const live = state('PUBLISHED', at(-60), at(60));
    expect(planPublish(live, undefined, NOW)).toBe(live);
    expect(planPublish(state('SCHEDULED', at(-1)), undefined, NOW)).toEqual(
      state('PUBLISHED', at(-1)),
    );
    // Republishing archived content starts a new window.
    expect(
      planPublish(state('ARCHIVED', at(-60), at(-30)), undefined, NOW),
    ).toEqual(state('PUBLISHED', NOW));
    // A future unpublish time is kept; the publish time must come first.
    expect(planPublish(state('DRAFT', null, at(60)), at(30), NOW)).toEqual(
      state('SCHEDULED', at(30), at(60)),
    );
    expect(() =>
      planPublish(state('DRAFT', null, at(60)), at(90), NOW),
    ).toThrow(BadRequestException);
  });

  it('unpublish now or later; never-live content returns to draft', () => {
    expect(() => planUnpublish(state('DRAFT'), undefined, NOW)).toThrow(
      ConflictException,
    );
    expect(planUnpublish(state('PUBLISHED', at(-5)), at(30), NOW)).toEqual(
      state('PUBLISHED', at(-5), at(30)),
    );
    expect(() =>
      planUnpublish(state('SCHEDULED', at(30)), at(10), NOW),
    ).toThrow(BadRequestException);
    expect(planUnpublish(state('SCHEDULED', at(30)), undefined, NOW)).toEqual(
      state('DRAFT'),
    );
    expect(planUnpublish(state('PUBLISHED', at(-5)), undefined, NOW)).toEqual(
      state('ARCHIVED', at(-5), NOW),
    );
    expect(planUnpublish(state('PUBLISHED'), undefined, NOW)).toEqual(
      state('ARCHIVED'),
    );
  });

  it('due schedules apply only while the state still calls for them', () => {
    expect(applyDue(state('SCHEDULED', at(-1)), 'PUBLISH', NOW)).toEqual(
      state('PUBLISHED', at(-1)),
    );
    expect(applyDue(state('SCHEDULED', at(1)), 'PUBLISH', NOW)).toBeNull();
    expect(applyDue(state('DRAFT'), 'PUBLISH', NOW)).toBeNull();
    expect(
      applyDue(state('PUBLISHED', at(-9), at(-1)), 'UNPUBLISH', NOW),
    ).toEqual(state('ARCHIVED', at(-9), at(-1)));
    expect(
      applyDue(state('PUBLISHED', at(-9), at(1)), 'UNPUBLISH', NOW),
    ).toBeNull();
    expect(applyDue(state('ARCHIVED', at(-9)), 'UNPUBLISH', NOW)).toBeNull();
  });

  it('pending schedules mirror the state', () => {
    expect(
      schedulesFor('PAGE', 'p', state('SCHEDULED', at(5), at(9)), NOW),
    ).toEqual([
      {
        targetType: 'PAGE',
        targetId: 'p',
        action: 'PUBLISH',
        runAt: at(5).toISOString(),
      },
      {
        targetType: 'PAGE',
        targetId: 'p',
        action: 'UNPUBLISH',
        runAt: at(9).toISOString(),
      },
    ]);
    expect(
      schedulesFor('PAGE', 'p', state('ARCHIVED', at(-5), at(9)), NOW).map(
        (r) => r.runAt,
      ),
    ).toEqual([null, null]);
  });
});

describe('ContentPublisher', () => {
  const EVENTS = {
    BEFORE_WRITE: 'page.before-write',
    ...publishingEvents('page'),
  };
  function setup() {
    const prisma = fakePrisma();
    const fb = fakeBus(prisma);
    return { pub: new ContentPublisher(fb.bus), prisma, ...fb };
  }

  it('publishes, records audited events and asks the scheduler to mirror the state', async () => {
    const { pub, prisma, after, afterNames } = setup();
    prisma.page.findUnique.mockResolvedValue({
      ...state('DRAFT'),
      storeId: null,
    });
    await pub.change('page', 'p', EVENTS, 'publish', at(30), ROOT, NOW);
    expect(prisma.page.update).toHaveBeenCalledWith({
      where: { id: 'p' },
      data: state('SCHEDULED', at(30)),
    });
    expect(afterNames()).toEqual([
      'page.scheduled',
      'content.schedule-requested',
    ]);
    expect(
      (after[1] as never as { data: { actorId: string } }).data.actorId,
    ).toBe(ROOT.id);
    await pub.change('page', 'p', EVENTS, 'publish', undefined, undefined, NOW);
    expect(afterNames()[2]).toBe('page.published');
    prisma.page.findUnique.mockResolvedValue({
      ...state('PUBLISHED', at(-5)),
      storeId: 's',
    });
    await pub.change('page', 'p', EVENTS, 'unpublish', undefined, ROOT, NOW);
    expect(afterNames()[4]).toBe('page.unpublished');
  });

  it('is a no-op when nothing changes, and 404s on missing content', async () => {
    const { pub, prisma, afterNames } = setup();
    prisma.page.findUnique.mockResolvedValue({
      ...state('PUBLISHED', at(-5)),
      storeId: null,
    });
    await pub.change('page', 'p', EVENTS, 'publish', undefined, ROOT, NOW);
    expect(afterNames()).toEqual([]);
    prisma.page.findUnique.mockResolvedValue(null);
    await expect(
      pub.change('page', 'x', EVENTS, 'publish', undefined, ROOT, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applies due schedules as the system, ignoring stale ones', async () => {
    const { pub, prisma, after, afterNames } = setup();
    prisma.banner.findUnique.mockResolvedValueOnce(null);
    expect(await pub.due('banner', 'b', 'PUBLISH', EVENTS, NOW)).toBe(false);
    prisma.banner.findUnique.mockResolvedValueOnce({
      ...state('DRAFT'),
      storeId: null,
    });
    expect(await pub.due('banner', 'b', 'PUBLISH', EVENTS, NOW)).toBe(false);
    prisma.banner.findUnique.mockResolvedValueOnce({
      ...state('SCHEDULED', at(-1)),
      storeId: null,
    });
    expect(await pub.due('banner', 'b', 'PUBLISH', EVENTS, NOW)).toBe(true);
    expect(afterNames()[0]).toBe('page.published');
    expect((after[0] as never as { actor: { type: string } }).actor.type).toBe(
      'system',
    );
  });

  it('cancels schedules of deleted content', () => {
    const { pub } = setup();
    const events: { name: string; data: { requests: { runAt: null }[] } }[] =
      [];
    pub.cancelSchedules(
      { add: (e: never) => events.push(e) } as never,
      'slider',
      's',
    );
    expect(events[0].data.requests.map((r) => r.runAt)).toEqual([null, null]);
  });
});
