import { Injectable } from '@nestjs/common';
import { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { MoneyDto } from '../carts/dto/cart.dto.js';
import { formatMoney } from '../pricing/money.js';
import { StoresQuery } from '../stores/stores.query.js';
import type {
  OverviewDto,
  OverviewQueryDto,
  OverviewTotalsDto,
} from './dto/report.dto.js';

const DAY_MS = 86_400_000;
/** Cancelled orders are not sales. */
const SALE = Prisma.sql`status <> 'CANCELED'`;

/** Back-office reports (dashboard KPIs). Money is never summed across currencies. */
@Injectable()
export class ReportsQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
  ) {}

  async overview(q: OverviewQueryDto, now = new Date()): Promise<OverviewDto> {
    const days = q.days ?? 30;
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const to = new Date(today + DAY_MS);
    const from = new Date(to.getTime() - days * DAY_MS);
    const prevFrom = new Date(from.getTime() - days * DAY_MS);

    const byCurrency = await this.prisma.$queryRaw<
      { currency: string; revenue: bigint }[]
    >`SELECT currency_code AS currency, sum(grand_total)::bigint AS revenue
        FROM orders
       WHERE placed_at >= ${from} AND placed_at < ${to} AND ${SALE}
       GROUP BY currency_code
       ORDER BY revenue DESC, currency_code`;
    const currencies = byCurrency.map((r) => r.currency);
    const currency = q.currency ?? currencies[0] ?? null;

    const snap = await this.stores.snapshot();
    const minor = currency
      ? (snap.currencies.get(currency)?.minorUnits ?? 2)
      : 2;
    const money = (amount: bigint): MoneyDto => ({
      amount: Number(amount),
      formatted: currency ? formatMoney(amount, currency, minor, 'en-US') : '',
    });

    const [current, previous, daily, top, byStatus] = await Promise.all([
      this.totals(from, to, currency, money),
      this.totals(prevFrom, from, currency, money),
      this.daily(from, to, currency),
      this.top(from, to, currency),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { placedAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
    ]);

    return {
      from,
      to,
      currency,
      currencies,
      current,
      previous,
      daily: Array.from({ length: days }, (_, i) => {
        const date = new Date(from.getTime() + i * DAY_MS)
          .toISOString()
          .slice(0, 10);
        const d = daily.get(date);
        return {
          date,
          revenue: Number(d?.revenue ?? 0n),
          orders: d?.orders ?? 0,
        };
      }),
      topProducts: top.map((t) => ({
        productId: t.productId,
        sku: t.sku,
        name: t.name,
        quantity: Number(t.quantity),
        revenue: money(t.revenue),
      })),
      byStatus: byStatus
        .map((s) => ({ status: s.status, count: s._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }

  private async totals(
    from: Date,
    to: Date,
    currency: string | null,
    money: (n: bigint) => MoneyDto,
  ): Promise<OverviewTotalsDto> {
    const [sales] = currency
      ? await this.prisma.$queryRaw<{ revenue: bigint; orders: bigint }[]>`
          SELECT coalesce(sum(grand_total), 0)::bigint AS revenue, count(*) AS orders
            FROM orders
           WHERE placed_at >= ${from} AND placed_at < ${to} AND ${SALE}
             AND currency_code = ${currency}`
      : [{ revenue: 0n, orders: 0n }];
    const newCustomers = await this.prisma.customer.count({
      where: { createdAt: { gte: from, lt: to } },
    });
    const orders = Number(sales.orders);
    return {
      revenue: money(sales.revenue),
      orders,
      averageOrderValue: money(orders ? sales.revenue / BigInt(orders) : 0n),
      newCustomers,
    };
  }

  private async daily(from: Date, to: Date, currency: string | null) {
    if (!currency) return new Map<string, never>();
    const rows = await this.prisma.$queryRaw<
      { date: string; revenue: bigint; orders: bigint }[]
    >`SELECT to_char(date_trunc('day', placed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
             sum(grand_total)::bigint AS revenue, count(*) AS orders
        FROM orders
       WHERE placed_at >= ${from} AND placed_at < ${to} AND ${SALE}
         AND currency_code = ${currency}
       GROUP BY 1`;
    return new Map(
      rows.map((r) => [
        r.date,
        { revenue: r.revenue, orders: Number(r.orders) },
      ]),
    );
  }

  private async top(from: Date, to: Date, currency: string | null) {
    if (!currency) return [];
    // Top-level lines only: bundle components would count the same sale twice.
    return this.prisma.$queryRaw<
      {
        productId: string | null;
        sku: string;
        name: string;
        quantity: bigint;
        revenue: bigint;
      }[]
    >`SELECT i.product_id AS "productId", i.sku, max(i.name) AS name,
             sum(i.quantity)::bigint AS quantity,
             sum(i.row_total - i.discount)::bigint AS revenue
        FROM order_items i
        JOIN orders o ON o.id = i.order_id
       WHERE o.placed_at >= ${from} AND o.placed_at < ${to}
         AND o.status <> 'CANCELED' AND o.currency_code = ${currency}
         AND i.parent_item_id IS NULL
       GROUP BY i.product_id, i.sku
       ORDER BY revenue DESC, quantity DESC
       LIMIT 5`;
  }
}
