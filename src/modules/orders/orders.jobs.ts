import { BadRequestException, Injectable } from '@nestjs/common';
import { CsvWriter, fileDate, minorToDecimal } from '../../common/csv/csv.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  JobCanceledError,
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
} from '../jobs/job-handler.js';
import { StoresQuery } from '../stores/stores.query.js';

const PAGE = 1000;
const STATUSES = [
  'PENDING_PAYMENT',
  'PROCESSING',
  'COMPLETE',
  'CANCELED',
  'CLOSED',
] as const;

/** `export.orders`: one row per order with its totals (decimals), for accounting and reporting. */
@JobHandler()
@Injectable()
export class ExportOrdersJob implements JobRunner {
  readonly info = {
    type: 'export.orders',
    title: 'Export orders',
    description:
      'Orders with status, customer e-mail, totals, payments, refunds, coupon, shipping method and destination. Optional parameters: from / to (ISO dates on the placement time), sinceHours (rolling window for scheduled exports), store (a code) and status.',
    permission: 'orders:read',
    exampleParams: { sinceHours: 24, store: 'us-en' },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['from', 'to', 'sinceHours', 'store', 'status']);
    const from = params.date(p, 'from');
    const to = params.date(p, 'to');
    if (from && to && from >= to)
      throw new BadRequestException('from must be before to');
    const since = p.sinceHours;
    if (
      since !== undefined &&
      (!Number.isInteger(since) ||
        (since as number) < 1 ||
        (since as number) > 24 * 366)
    )
      throw new BadRequestException(
        'sinceHours must be a whole number of hours',
      );
    if (since !== undefined && from)
      throw new BadRequestException('Send from/to or sinceHours, not both');
    const store = params.string(p, 'store', { max: 64 });
    if (store && !(await this.stores.snapshot(true)).byCode.has(store))
      throw new BadRequestException(`Unknown store ${store}`);
    const status =
      p.status === undefined
        ? undefined
        : params.oneOf(p, 'status', STATUSES, 'PROCESSING');
    return {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(since !== undefined ? { sinceHours: since } : {}),
      ...(store ? { store } : {}),
      ...(status ? { status } : {}),
    };
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const p = ctx.params;
    const snap = await this.stores.snapshot(true);
    const storeCode = new Map(
      [...snap.byId.values()].map((s) => [s.id, s.code]),
    );
    const from = p.sinceHours
      ? new Date(Date.now() - (p.sinceHours as number) * 3_600_000)
      : p.from
        ? new Date(p.from as string)
        : undefined;
    const to = p.to ? new Date(p.to as string) : undefined;
    const where: Prisma.OrderWhereInput = {
      ...(from || to
        ? {
            placedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
      ...(p.store ? { storeId: snap.byCode.get(p.store as string)?.id } : {}),
      ...(p.status ? { status: p.status as (typeof STATUSES)[number] } : {}),
    };
    const csv = new CsvWriter([
      'number',
      'placed_at',
      'store',
      'status',
      'payment_status',
      'fulfillment_status',
      'email',
      'customer_group',
      'currency',
      'subtotal',
      'discount',
      'shipping',
      'tax',
      'grand_total',
      'points_amount',
      'paid',
      'refunded',
      'items',
      'coupon',
      'shipping_method',
      'shipping_country',
    ]);
    const total = await this.prisma.order.count({ where });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.order.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          number: true,
          placedAt: true,
          storeId: true,
          status: true,
          paymentStatus: true,
          fulfillmentStatus: true,
          email: true,
          customerGroupCode: true,
          currencyCode: true,
          subtotal: true,
          discountTotal: true,
          shippingTotal: true,
          taxTotal: true,
          grandTotal: true,
          loyaltyAmount: true,
          amountPaid: true,
          amountRefunded: true,
          couponCode: true,
          shippingMethodName: true,
          items: { where: { parentItemId: null }, select: { quantity: true } },
          addresses: {
            where: { type: 'SHIPPING' },
            select: { countryCode: true },
          },
        },
      });
      if (!rows.length) break;
      csv.add(
        rows.map((o) => {
          const minor = snap.currencies.get(o.currencyCode)?.minorUnits ?? 2;
          const m = (v: bigint) => minorToDecimal(v, minor);
          return [
            o.number,
            o.placedAt,
            storeCode.get(o.storeId) ?? '',
            o.status,
            o.paymentStatus,
            o.fulfillmentStatus,
            o.email,
            o.customerGroupCode,
            o.currencyCode,
            m(o.subtotal),
            m(o.discountTotal),
            m(o.shippingTotal),
            m(o.taxTotal),
            m(o.grandTotal),
            m(o.loyaltyAmount),
            m(o.amountPaid),
            m(o.amountRefunded),
            o.items.reduce((n, i) => n + i.quantity, 0),
            o.couponCode,
            o.shippingMethodName,
            o.addresses[0]?.countryCode ?? '',
          ];
        }),
      );
      cursor = rows[rows.length - 1].id;
      await ctx.progress(csv.rows, total);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return {
      stats: { rows: csv.rows },
      output: {
        name: `orders-${fileDate()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}
