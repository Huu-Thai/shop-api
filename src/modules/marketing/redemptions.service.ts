import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type ActorRef } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { localeChain } from '../../common/i18n/locale-chain.js';
import { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { CustomersQuery } from '../customers/customers.query.js';
import { GUEST_GROUP } from '../customers/customers.events.js';
import { ProductsQuery } from '../products/products.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import {
  CouponStatus,
  type EvaluateCartDto,
  type EvaluationDto,
  type RedeemDto,
  type RedemptionDto,
  type UsageDto,
} from './dto/marketing.dto.js';
import { PROMOTION_EVENTS, type RedeemedData } from './marketing.events.js';
import {
  type CartLine,
  type Evaluation,
  evaluate,
} from './promotion-engine.js';
import {
  type CouponCheck,
  couponCheck,
  PromotionsQuery,
} from './promotions.query.js';

export interface CartEvaluationInput {
  websiteId: string;
  currencyCode: string;
  customerGroupCode: string;
  customerId: string | null;
  couponCode: string | null;
  lines: CartLine[];
  shippingAmount: bigint;
  localeChain: readonly string[];
}

export interface LinesEvaluation {
  result: Evaluation;
  coupon: CouponCheck | null;
  couponId: string | null;
}

const USAGE_SELECT = {
  id: true,
  promotionId: true,
  couponId: true,
  customerId: true,
  orderRef: true,
  discount: true,
  currencyCode: true,
  status: true,
  createdAt: true,
} as const;

const usageDto = (
  u: Prisma.PromotionUsageGetPayload<{ select: typeof USAGE_SELECT }>,
): UsageDto => ({
  ...u,
  discount: u.discount.toString(),
});

interface Prepared {
  dto: EvaluationDto;
  result: Evaluation;
  couponId: string | null;
}

/**
 * Evaluates carts against the active promotions, and records their use by orders. Recording is
 * concurrency-safe: usage limits are claimed with conditional UPDATEs (the row lock also serialises
 * per-customer checks), so a limited coupon can't be used more often than allowed, whatever the
 * load. Checkout (Phase 6) calls `redeem` when an order is placed and `release` when it's cancelled.
 */
@Injectable()
export class RedemptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly promotions: PromotionsQuery,
    private readonly products: ProductsQuery,
    private readonly customers: CustomersQuery,
    private readonly stores: StoresQuery,
  ) {}

  async evaluate(input: EvaluateCartDto): Promise<EvaluationDto> {
    return (await this.prepare(input)).dto;
  }

  private async prepare(
    input: EvaluateCartDto,
    now = new Date(),
  ): Promise<Prepared> {
    const group =
      input.customerGroupCode ??
      (input.customerId
        ? await this.customers.groupOfCustomer(input.customerId)
        : undefined) ??
      GUEST_GROUP;
    // One line per SKU (repeated SKUs are merged).
    const merged = new Map<string, { quantity: number; unitPrice: number }>();
    for (const i of input.items) {
      const m = merged.get(i.sku);
      merged.set(i.sku, {
        quantity: (m?.quantity ?? 0) + i.quantity,
        unitPrice: i.unitPrice,
      });
    }
    const facts = await this.products.cartFacts([...merged.keys()]);
    const lines: CartLine[] = [...merged].flatMap(([sku, l]) => {
      const f = facts.get(sku);
      return f
        ? [
            {
              key: sku,
              sku,
              productId: f.productId,
              categoryIds: f.categoryIds,
              quantity: l.quantity,
              unitPrice: BigInt(l.unitPrice),
            },
          ]
        : [];
    });
    const { fallbacks } = await this.stores.snapshot();
    const chain = input.localeCode
      ? localeChain(input.localeCode, fallbacks, input.localeCode)
      : [];
    const {
      result,
      coupon: couponResult,
      couponId,
    } = await this.evaluateLines(
      {
        websiteId: input.websiteId,
        currencyCode: input.currencyCode,
        customerGroupCode: group,
        customerId: input.customerId ?? null,
        couponCode: input.couponCode ?? null,
        lines,
        shippingAmount: BigInt(input.shippingAmount ?? 0),
        localeChain: chain,
      },
      now,
    );
    const discountOf = new Map(result.lines.map((l) => [l.key, l.discount]));
    return {
      result,
      couponId,
      dto: {
        currencyCode: input.currencyCode,
        subtotal: result.subtotal.toString(),
        discountTotal: result.discountTotal.toString(),
        total: result.total.toString(),
        freeShipping: result.freeShipping,
        shippingDiscount: result.shippingDiscount.toString(),
        lines: lines.map((l) => ({
          sku: l.sku,
          quantity: l.quantity,
          lineTotal: (l.unitPrice * BigInt(l.quantity)).toString(),
          discount: (discountOf.get(l.key) ?? 0n).toString(),
        })),
        applied: result.applied.map((a) => ({
          ...a,
          discount: a.discount.toString(),
        })),
        coupon: couponResult
          ? {
              code: couponResult.code,
              status: couponResult.status,
              message: couponResult.message,
            }
          : null,
        unknownSkus: [...merged.keys()].filter((s) => !facts.has(s)),
      },
    };
  }

  /**
   * Evaluates lines a caller has already resolved (carts and orders key them by line, so two bundle
   * lines with the same SKU stay apart). The coupon result is final: a usable coupon whose rule
   * didn't apply comes back NOT_APPLICABLE.
   */
  async evaluateLines(
    input: CartEvaluationInput,
    now = new Date(),
  ): Promise<LinesEvaluation> {
    const { rules, coupon } = await this.promotions.cartRules({
      websiteId: input.websiteId,
      customerId: input.customerId,
      couponCode: input.couponCode,
      localeChain: input.localeChain,
      now,
    });
    const result = evaluate(
      {
        currencyCode: input.currencyCode,
        customerGroupCode: input.customerGroupCode,
        lines: input.lines,
        shippingAmount: input.shippingAmount,
      },
      rules,
    );
    const final =
      coupon?.status === CouponStatus.APPLIED &&
      !result.applied.some((a) => a.promotionId === coupon.promotionId)
        ? couponCheck(coupon.code, CouponStatus.NOT_APPLICABLE, coupon)
        : coupon;
    return {
      result,
      coupon: final,
      couponId: final?.status === CouponStatus.APPLIED ? final.couponId : null,
    };
  }

  /**
   * Records the promotions of an evaluated cart for an order (checkout). Idempotent per order:
   * a retry returns the uses already recorded.
   */
  async redeemEvaluation(
    input: {
      orderRef: string;
      customerId: string | null;
      currencyCode: string;
      evaluation: LinesEvaluation;
    },
    actor: ActorRef,
  ): Promise<UsageDto[]> {
    const existing = await this.usages(input.orderRef);
    if (existing.length) return existing;
    const { result, couponId, coupon } = input.evaluation;
    if (coupon && coupon.status !== CouponStatus.APPLIED)
      throw new ConflictException(coupon.message);
    if (!result.applied.length) return [];
    return this.record(input, result.applied, couponId, actor);
  }

  private record(
    input: {
      orderRef: string;
      customerId: string | null;
      currencyCode: string;
    },
    applied: Evaluation['applied'],
    couponId: string | null,
    actor: ActorRef,
  ): Promise<UsageDto[]> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROMOTION_EVENTS.BEFORE_WRITE,
        'redeem',
        null,
        actor,
        { orderRef: input.orderRef },
      ),
      work: async (tx, after) => {
        const out: UsageDto[] = [];
        for (const a of applied) {
          await claimPromotion(tx, a.promotionId, input.customerId);
          const coupon = a.couponCode ? couponId : null;
          if (coupon) await claimCoupon(tx, coupon, input.customerId);
          const u = await tx.promotionUsage.create({
            data: {
              promotionId: a.promotionId,
              couponId: coupon,
              customerId: input.customerId,
              orderRef: input.orderRef,
              discount: a.discount,
              currencyCode: input.currencyCode,
            },
            select: USAGE_SELECT,
          });
          out.push(usageDto(u));
        }
        after.add(
          new ProjectionEvent<RedeemedData>(PROMOTION_EVENTS.REDEEMED, {
            orderRef: input.orderRef,
            customerId: input.customerId,
            promotionIds: applied.map((a) => a.promotionId),
            couponId,
          }),
        );
        return out;
      },
    });
  }

  async usages(orderRef: string): Promise<UsageDto[]> {
    const rows = await this.prisma.promotionUsage.findMany({
      where: { orderRef },
      select: USAGE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(usageDto);
  }

  /**
   * Records the promotions an order uses (re-evaluated on the server, never trusted from the
   * client). Idempotent per order reference. 409 when a limit was reached meanwhile or the coupon
   * no longer applies — the caller re-evaluates the cart.
   */
  async redeem(input: RedeemDto, actor: ActorRef): Promise<RedemptionDto> {
    const existing = await this.usages(input.orderRef);
    if (existing.length) {
      const { dto } = await this.prepare(input);
      return { evaluation: dto, usages: existing };
    }
    const { dto, result, couponId } = await this.prepare(input);
    if (dto.coupon && dto.coupon.status !== CouponStatus.APPLIED)
      throw new ConflictException(dto.coupon.message);
    if (!result.applied.length) return { evaluation: dto, usages: [] };
    const usages = await this.record(
      {
        orderRef: input.orderRef,
        customerId: input.customerId ?? null,
        currencyCode: input.currencyCode,
      },
      result.applied,
      couponId,
      actor,
    );
    return { evaluation: dto, usages };
  }

  /** The order was cancelled: its uses no longer count against the limits. Idempotent. */
  async release(orderRef: string, actor: ActorRef): Promise<UsageDto[]> {
    return this.bus.write({
      before: new BeforeWriteEvent(
        PROMOTION_EVENTS.BEFORE_WRITE,
        'release',
        null,
        actor,
        { orderRef },
      ),
      work: async (tx, after) => {
        const released = await tx.$queryRaw<
          { id: string; promotionId: string; couponId: string | null }[]
        >`
          UPDATE promotion_usages SET status = 'RELEASED', released_at = now()
           WHERE order_ref = ${orderRef} AND status = 'APPLIED'
          RETURNING id, promotion_id AS "promotionId", coupon_id AS "couponId"`;
        if (!released.length) {
          if (!(await tx.promotionUsage.count({ where: { orderRef } })))
            throw new NotFoundException(
              `No promotions were used by order ${orderRef}`,
            );
        }
        for (const r of released) {
          await tx.$executeRaw`UPDATE promotions SET times_used = GREATEST(times_used - 1, 0) WHERE id = ${r.promotionId}::uuid`;
          if (r.couponId)
            await tx.$executeRaw`UPDATE coupons SET times_used = GREATEST(times_used - 1, 0) WHERE id = ${r.couponId}::uuid`;
        }
        if (released.length)
          after.add(
            new ProjectionEvent(PROMOTION_EVENTS.RELEASED, {
              orderRef,
              promotionIds: released.map((r) => r.promotionId),
            }),
          );
        const rows = await tx.promotionUsage.findMany({
          where: { orderRef },
          select: USAGE_SELECT,
        });
        return rows.map(usageDto);
      },
    });
  }
}

/** Takes one use of a promotion, or 409 when its total or per-customer limit is reached. */
async function claimPromotion(
  tx: PrismaTransaction,
  id: string,
  customerId: string | null,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ usesPerCustomer: number | null }[]>`
    UPDATE promotions SET times_used = times_used + 1
     WHERE id = ${id}::uuid AND (usage_limit IS NULL OR times_used < usage_limit)
    RETURNING uses_per_customer AS "usesPerCustomer"`;
  if (!row)
    throw new ConflictException(
      'A promotion in the cart is no longer available',
    );
  if (customerId && row.usesPerCustomer !== null) {
    const used = await tx.promotionUsage.count({
      where: { promotionId: id, customerId, status: 'APPLIED' },
    });
    if (used >= row.usesPerCustomer)
      throw new ConflictException('You have already used this promotion');
  }
}

async function claimCoupon(
  tx: PrismaTransaction,
  id: string,
  customerId: string | null,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ usesPerCustomer: number | null }[]>`
    UPDATE coupons SET times_used = times_used + 1
     WHERE id = ${id}::uuid AND is_active AND (usage_limit IS NULL OR times_used < usage_limit)
       AND (expires_at IS NULL OR expires_at > now())
    RETURNING uses_per_customer AS "usesPerCustomer"`;
  if (!row) throw new ConflictException('This coupon has been used up');
  if (customerId && row.usesPerCustomer !== null) {
    const used = await tx.promotionUsage.count({
      where: { couponId: id, customerId, status: 'APPLIED' },
    });
    if (used >= row.usesPerCustomer)
      throw new ConflictException('You have already used this coupon');
  }
}
