import { timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { sha256 } from '../../common/auth/api-key-format.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { MoneyDto } from '../carts/dto/cart.dto.js';
import { formatMoney } from '../pricing/money.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { StoresQuery } from '../stores/stores.query.js';
import type {
  AdminOrderDto,
  AdminOrderSummaryDto,
  ListOrdersQueryDto,
  OrderDto,
  OrderItemDto,
  OrderSummaryDto,
} from './dto/order.dto.js';

const ITEM_SELECT = {
  id: true,
  parentItemId: true,
  sku: true,
  name: true,
  productType: true,
  quantity: true,
  unitPrice: true,
  rowTotal: true,
  discount: true,
  taxAmount: true,
  taxRate: true,
  qtyShipped: true,
  qtyRefunded: true,
  options: true,
  reservationGroupId: true,
} as const;

const VIEW_SELECT = {
  id: true,
  number: true,
  storeId: true,
  customerId: true,
  customerGroupCode: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  email: true,
  currencyCode: true,
  localeCode: true,
  placedAt: true,
  paidAt: true,
  canceledAt: true,
  pricesIncludeTax: true,
  subtotal: true,
  discountTotal: true,
  shippingTotal: true,
  taxTotal: true,
  grandTotal: true,
  loyaltyPoints: true,
  loyaltyAmount: true,
  amountDue: true,
  amountPaid: true,
  amountRefunded: true,
  shippingMethodName: true,
  couponCode: true,
  discounts: true,
  items: { select: ITEM_SELECT, orderBy: [{ id: 'asc' }] },
  addresses: {
    select: {
      type: true,
      firstName: true,
      lastName: true,
      company: true,
      phone: true,
      countryCode: true,
      regionCode: true,
      city: true,
      postcode: true,
      line1: true,
      line2: true,
    },
  },
  shipments: {
    select: {
      id: true,
      number: true,
      carrier: true,
      trackingNumber: true,
      trackingUrl: true,
      status: true,
      shippedAt: true,
      deliveredAt: true,
      items: {
        select: {
          orderItemId: true,
          quantity: true,
          orderItem: { select: { sku: true } },
        },
      },
    },
    orderBy: { shippedAt: 'asc' },
  },
  invoices: { select: { number: true, grandTotal: true, issuedAt: true } },
  creditMemos: {
    select: { number: true, amount: true, issuedAt: true },
    orderBy: { issuedAt: 'asc' },
  },
  history: {
    select: {
      event: true,
      message: true,
      createdAt: true,
      actorLabel: true,
      isPublic: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.OrderSelect;

type ViewRow = Prisma.OrderGetPayload<{ select: typeof VIEW_SELECT }>;

export interface PaymentFacts {
  id: string;
  number: string;
  storeId: string;
  websiteId: string;
  customerId: string | null;
  email: string;
  localeCode: string;
  status: string;
  paymentStatus: string;
  currencyCode: string;
  amountDue: bigint;
  amountPaid: bigint;
  amountRefunded: bigint;
  billingCountry: string | null;
}

/** Order read models: the shopper's (customer or guest token), staff views, and facts for payments. */
@Injectable()
export class OrdersQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
  ) {}

  /** Finds an order of this store the request may see: the signed-in owner, or the guest token. */
  async accessible(
    ctx: StoreContext,
    number: string,
    orderToken?: string,
  ): Promise<string> {
    const o = await this.prisma.order.findFirst({
      where: { number, storeId: ctx.storeId },
      select: { id: true, customerId: true, accessTokenHash: true },
    });
    const byCustomer =
      !!o && !!ctx.customer && o.customerId === ctx.customer.id;
    const byToken =
      !!o &&
      !!orderToken &&
      timingSafeEqual(
        Buffer.from(sha256(orderToken)),
        Buffer.from(o.accessTokenHash),
      );
    if (!o || !(byCustomer || byToken))
      throw new NotFoundException(`Order ${number} not found`);
    return o.id;
  }

  async view(orderId: string, staff = false): Promise<AdminOrderDto> {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: VIEW_SELECT,
    });
    if (!o) throw new NotFoundException(`Order ${orderId} not found`);
    return this.toView(o, staff);
  }

  /** The storefront view (no staff-only fields or history). */
  async publicView(orderId: string): Promise<OrderDto> {
    const {
      storeId: _s,
      customerId: _c,
      customerGroupCode: _g,
      ...v
    } = await this.view(orderId, false);
    return v;
  }

  async list(q: ListOrdersQueryDto): Promise<Paginated<AdminOrderSummaryDto>> {
    const where: Prisma.OrderWhereInput = {
      storeId: q.storeId,
      customerId: q.customerId,
      status: q.status,
      paymentStatus: q.paymentStatus,
      fulfillmentStatus: q.fulfillmentStatus,
      ...(q.placedFrom || q.placedTo
        ? {
            placedAt: {
              ...(q.placedFrom ? { gte: new Date(q.placedFrom) } : {}),
              ...(q.placedTo ? { lt: new Date(q.placedTo) } : {}),
            },
          }
        : {}),
      ...(q.search
        ? {
            OR: [
              { number: { contains: q.search.toUpperCase() } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ placedAt: q.order }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const fmt = await this.formatter();
    return paginated(
      rows.map((r) => ({
        ...summary(r, fmt),
        email: r.email,
        storeId: r.storeId,
      })),
      total,
      q,
    );
  }

  async forCustomer(
    ctx: StoreContext,
    customerId: string,
    q: ListOrdersQueryDto,
  ): Promise<Paginated<OrderSummaryDto>> {
    const where: Prisma.OrderWhereInput = { customerId, storeId: ctx.storeId };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const fmt = await this.formatter(ctx.localeCode);
    return paginated(
      rows.map((r) => summary(r, fmt)),
      total,
      q,
    );
  }

  /** What payments need to know about an order. */
  async paymentFacts(orderId: string): Promise<PaymentFacts> {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        storeId: true,
        websiteId: true,
        customerId: true,
        email: true,
        localeCode: true,
        status: true,
        paymentStatus: true,
        currencyCode: true,
        amountDue: true,
        amountPaid: true,
        amountRefunded: true,
        addresses: {
          where: { type: 'BILLING' },
          select: { countryCode: true },
        },
      },
    });
    if (!o) throw new NotFoundException(`Order ${orderId} not found`);
    const { addresses, ...rest } = o;
    return { ...rest, billingCountry: addresses[0]?.countryCode ?? null };
  }

  /** Lines with their reservations and amounts (stock and loyalty effects). */
  async effects(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        customerId: true,
        currencyCode: true,
        pricesIncludeTax: true,
        loyaltyPoints: true,
        amountPaid: true,
        items: { select: ITEM_SELECT },
      },
    });
    if (!o) throw new NotFoundException(`Order ${orderId} not found`);
    const top = o.items.filter((i) => !i.parentItemId);
    // Points are earned on what the goods cost after discounts, without tax.
    const eligible = top.reduce(
      (s, i) =>
        s + i.rowTotal - i.discount - (o.pricesIncludeTax ? i.taxAmount : 0n),
      0n,
    );
    return { ...o, eligible };
  }

  private async formatter(locale?: string) {
    const snap = await this.stores.snapshot();
    return (amount: bigint, currency: string, l = locale ?? 'en-US') =>
      formatMoney(
        amount,
        currency,
        snap.currencies.get(currency)?.minorUnits ?? 2,
        l,
      );
  }

  private async toView(o: ViewRow, staff: boolean): Promise<AdminOrderDto> {
    const fmt = await this.formatter(o.localeCode);
    const money = (amount: bigint): MoneyDto => ({
      amount: Number(amount),
      formatted: fmt(amount, o.currencyCode),
    });
    const item = (i: (typeof o.items)[number]): OrderItemDto => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      type: i.productType,
      quantity: i.quantity,
      unitPrice: money(i.unitPrice),
      rowTotal: money(i.rowTotal),
      discount: money(i.discount),
      tax: money(i.taxAmount),
      taxRate: i.taxRate.toFixed(4),
      qtyShipped: i.qtyShipped,
      qtyRefunded: i.qtyRefunded,
      options: (i.options ?? {}) as Record<string, unknown>,
      children: o.items.filter((c) => c.parentItemId === i.id).map(item),
    });
    const addr = (type: 'SHIPPING' | 'BILLING') => {
      const a = o.addresses.find((x) => x.type === type);
      if (!a) return null;
      const { type: _t, ...rest } = a;
      return rest;
    };
    return {
      id: o.id,
      number: o.number,
      storeId: o.storeId,
      customerId: o.customerId,
      customerGroupCode: o.customerGroupCode,
      status: o.status,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      email: o.email,
      currency: o.currencyCode,
      placedAt: o.placedAt,
      paidAt: o.paidAt,
      canceledAt: o.canceledAt,
      items: o.items.filter((i) => !i.parentItemId).map(item),
      totals: {
        subtotal: money(o.subtotal),
        discount: money(o.discountTotal),
        shipping: money(o.shippingTotal),
        tax: money(o.taxTotal),
        grandTotal: money(o.grandTotal),
        loyalty: money(o.loyaltyAmount),
        amountDue: money(o.amountDue),
        amountPaid: money(o.amountPaid),
        amountRefunded: money(o.amountRefunded),
        pricesIncludeTax: o.pricesIncludeTax,
      },
      shippingAddress: addr('SHIPPING'),
      billingAddress: addr('BILLING'),
      shippingMethod: o.shippingMethodName,
      couponCode: o.couponCode,
      loyaltyPoints: o.loyaltyPoints,
      promotions: (o.discounts as { label: string; discount: string }[]).map(
        (d) => ({
          label: d.label,
          discount: money(BigInt(d.discount)),
        }),
      ),
      shipments: o.shipments.map((s) => ({
        id: s.id,
        number: s.number,
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        trackingUrl: s.trackingUrl,
        status: s.status,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
        items: s.items.map((x) => ({
          orderItemId: x.orderItemId,
          sku: x.orderItem.sku,
          quantity: x.quantity,
        })),
      })),
      invoices: o.invoices.map((d) => ({
        number: d.number,
        amount: money(d.grandTotal),
        issuedAt: d.issuedAt,
      })),
      creditMemos: o.creditMemos.map((d) => ({
        number: d.number,
        amount: money(d.amount),
        issuedAt: d.issuedAt,
      })),
      history: o.history
        .filter((h) => staff || h.isPublic)
        .map((h) =>
          staff
            ? h
            : { event: h.event, message: h.message, createdAt: h.createdAt },
        ),
    };
  }
}

const SUMMARY_SELECT = {
  id: true,
  number: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  grandTotal: true,
  currencyCode: true,
  placedAt: true,
  email: true,
  storeId: true,
  items: { where: { parentItemId: null }, select: { quantity: true } },
} as const satisfies Prisma.OrderSelect;

function summary(
  r: Prisma.OrderGetPayload<{ select: typeof SUMMARY_SELECT }>,
  fmt: (amount: bigint, currency: string) => string,
): OrderSummaryDto {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    paymentStatus: r.paymentStatus,
    fulfillmentStatus: r.fulfillmentStatus,
    grandTotal: {
      amount: Number(r.grandTotal),
      formatted: fmt(r.grandTotal, r.currencyCode),
    },
    itemCount: r.items.reduce((n, i) => n + i.quantity, 0),
    placedAt: r.placedAt,
  };
}
