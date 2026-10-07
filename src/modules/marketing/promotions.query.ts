import { Injectable } from '@nestjs/common';
import { visibleWhere } from '../../common/content/publishing.js';
import { pickTranslation } from '../../common/i18n/locale-chain.js';
import { PrismaService } from '../../database/prisma.service.js';
import { CouponStatus } from './dto/marketing.dto.js';
import type { Rule } from './promotion-engine.js';
import type { Action, Condition } from './promotion-rules.js';

export interface CouponCheck {
  code: string;
  status: CouponStatus;
  message: string;
  couponId: string | null;
  promotionId: string | null;
}

export interface CartRules {
  rules: (Rule & {
    usageLimit: number | null;
    usesPerCustomer: number | null;
  })[];
  coupon: CouponCheck | null;
}

const MESSAGES: Record<CouponStatus, string> = {
  APPLIED: 'The coupon is applied',
  NOT_FOUND: 'This coupon code is not valid',
  INACTIVE: 'This coupon is not active',
  EXPIRED: 'This coupon has expired',
  USED_UP: 'This coupon has been used up',
  ALREADY_USED: 'You have already used this offer',
  NOT_APPLICABLE:
    'The coupon is valid, but the cart doesn’t meet its conditions',
};

export const couponCheck = (
  code: string,
  status: CouponStatus,
  ids: { couponId?: string | null; promotionId?: string | null } = {},
): CouponCheck => ({
  code,
  status,
  message: MESSAGES[status],
  couponId: ids.couponId ?? null,
  promotionId: ids.promotionId ?? null,
});

/**
 * The promotions that can apply to a cart right now (PLAN.md §9): published and within their
 * window, inside their campaign's window, assigned to the website, under their usage limits —
 * plus the coupon the shopper entered, checked. Time-based like content: a campaign starts and
 * ends exactly on time, whether or not the scheduler has run yet.
 */
@Injectable()
export class PromotionsQuery {
  constructor(private readonly prisma: PrismaService) {}

  async cartRules(input: {
    websiteId: string;
    customerId?: string | null;
    couponCode?: string | null;
    localeChain: readonly string[];
    now?: Date;
  }): Promise<CartRules> {
    const now = input.now ?? new Date();
    const active = {
      AND: [
        visibleWhere(now),
        { OR: [{ campaignId: null }, { campaign: visibleWhere(now) }] },
      ],
    };
    const rows = await this.prisma.promotion.findMany({
      where: { ...active, websites: { some: { websiteId: input.websiteId } } },
      select: {
        id: true,
        name: true,
        priority: true,
        stopFurther: true,
        requiresCoupon: true,
        conditions: true,
        actions: true,
        usageLimit: true,
        usesPerCustomer: true,
        timesUsed: true,
        translations: {
          where: { localeCode: { in: [...input.localeChain] } },
          select: { localeCode: true, label: true },
        },
      },
    });
    const usedByCustomer = new Map<string, number>();
    if (input.customerId && rows.some((r) => r.usesPerCustomer)) {
      const used = await this.prisma.promotionUsage.groupBy({
        by: ['promotionId'],
        where: {
          customerId: input.customerId,
          status: 'APPLIED',
          promotionId: { in: rows.map((r) => r.id) },
        },
        _count: { _all: true },
      });
      for (const u of used) usedByCustomer.set(u.promotionId, u._count._all);
    }
    const usedUpByCustomer = new Set(
      rows
        .filter(
          (r) =>
            r.usesPerCustomer !== null &&
            (usedByCustomer.get(r.id) ?? 0) >= r.usesPerCustomer,
        )
        .map((r) => r.id),
    );
    const available = rows.filter(
      (r) =>
        (r.usageLimit === null || r.timesUsed < r.usageLimit) &&
        !usedUpByCustomer.has(r.id),
    );

    const coupon = input.couponCode
      ? await this.checkCoupon(
          input.couponCode,
          input.customerId ?? null,
          new Set(available.map((r) => r.id)),
          new Set(rows.map((r) => r.id)),
          usedUpByCustomer,
          now,
        )
      : null;
    const unlocked =
      coupon && coupon.status === CouponStatus.APPLIED
        ? coupon.promotionId
        : null;
    return {
      coupon,
      rules: available
        .filter((r) => !r.requiresCoupon || r.id === unlocked)
        .map((r) => ({
          id: r.id,
          label:
            pickTranslation(r.translations, input.localeChain)?.label ?? r.name,
          priority: r.priority,
          stopFurther: r.stopFurther,
          conditions: r.conditions as unknown as Condition[],
          actions: r.actions as unknown as Action[],
          couponCode: r.id === unlocked ? coupon!.code : null,
          usageLimit: r.usageLimit,
          usesPerCustomer: r.usesPerCustomer,
        })),
    };
  }

  /** APPLIED here means "usable"; the caller downgrades it to NOT_APPLICABLE if it didn't apply. */
  private async checkCoupon(
    raw: string,
    customerId: string | null,
    available: ReadonlySet<string>,
    activeHere: ReadonlySet<string>,
    usedByThisCustomer: ReadonlySet<string>,
    now: Date,
  ): Promise<CouponCheck> {
    const code = raw.trim();
    const c = await this.prisma.coupon.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        promotionId: true,
        isActive: true,
        expiresAt: true,
        usageLimit: true,
        usesPerCustomer: true,
        timesUsed: true,
      },
    });
    if (!c) return couponCheck(code, CouponStatus.NOT_FOUND);
    const ids = { couponId: c.id, promotionId: c.promotionId };
    if (!c.isActive || !activeHere.has(c.promotionId))
      return couponCheck(c.code, CouponStatus.INACTIVE, ids);
    if (c.expiresAt && c.expiresAt <= now)
      return couponCheck(c.code, CouponStatus.EXPIRED, ids);
    if (usedByThisCustomer.has(c.promotionId))
      return couponCheck(c.code, CouponStatus.ALREADY_USED, ids);
    if (
      !available.has(c.promotionId) ||
      (c.usageLimit !== null && c.timesUsed >= c.usageLimit)
    )
      return couponCheck(c.code, CouponStatus.USED_UP, ids);
    if (customerId && c.usesPerCustomer !== null) {
      const used = await this.prisma.promotionUsage.count({
        where: { couponId: c.id, customerId, status: 'APPLIED' },
      });
      if (used >= c.usesPerCustomer)
        return couponCheck(c.code, CouponStatus.ALREADY_USED, ids);
    }
    return couponCheck(c.code, CouponStatus.APPLIED, ids);
  }
}
