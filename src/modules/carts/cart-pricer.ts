import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { CustomersQuery } from '../customers/customers.query.js';
import { GUEST_GROUP } from '../customers/customers.events.js';
import { InventoryQuery } from '../inventory/inventory.query.js';
import { LoyaltyQuery } from '../loyalty/loyalty.query.js';
import {
  type LinesEvaluation,
  RedemptionsService,
} from '../marketing/redemptions.service.js';
import type { CartLine } from '../marketing/promotion-engine.js';
import { formatMoney } from '../pricing/money.js';
import { PricingQuery } from '../pricing/pricing.query.js';
import { ProductsQuery } from '../products/products.query.js';
import {
  type ShippingOption,
  ShippingQuery,
} from '../shipping/shipping.query.js';
import { resolveStoreContext } from '../stores/context/store-context.guard.js';
import type { StoreContext } from '../stores/context/store-context.js';
import { StoresQuery } from '../stores/stores.query.js';
import type { AppliedTax } from '../tax/tax-engine.js';
import { TaxQuery } from '../tax/tax.query.js';
import {
  type BundleChoice,
  type BundleComponent,
  resolveBundle,
  unitPriceFor,
} from './cart-math.js';

export const CART_SELECT = {
  id: true,
  storeId: true,
  customerId: true,
  status: true,
  currencyCode: true,
  email: true,
  couponCode: true,
  shippingAddress: true,
  billingAddress: true,
  shippingMethodId: true,
  loyaltyPoints: true,
  version: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      variantId: true,
      quantity: true,
      options: true,
      signature: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.CartSelect;

export type CartRow = Prisma.CartGetPayload<{ select: typeof CART_SELECT }>;

export interface AddressInput {
  firstName: string;
  lastName: string;
  company?: string | null;
  phone?: string | null;
  countryCode: string;
  regionCode?: string | null;
  city: string;
  postcode?: string | null;
  line1: string;
  line2?: string | null;
}

/** Physical goods need an address and a shipping method; virtual ones don't. */
const SHIPPABLE = new Set(['SIMPLE', 'CONFIGURABLE', 'BUNDLE']);

export interface PricedLine {
  itemId: string;
  variantId: string;
  productId: string | null;
  sku: string;
  name: string;
  type: string;
  quantity: number;
  options: BundleChoice[];
  attributes: Record<string, string>;
  components: BundleComponent[];
  unitPrice: bigint;
  rowTotal: bigint;
  discount: bigint;
  taxAmount: bigint;
  taxRate: string;
  taxClassId: string | null;
  available: boolean;
  message: string | null;
}

export interface PricedCart {
  cart: CartRow;
  ctx: StoreContext;
  customerGroupCode: string;
  lines: PricedLine[];
  evaluation: LinesEvaluation;
  shippingOptions: ShippingOption[];
  shipping: ShippingOption | null;
  shippingAmount: bigint;
  shippingDiscount: bigint;
  shippingTax: bigint;
  subtotal: bigint;
  discountTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  loyaltyPoints: number;
  loyaltyAmount: bigint;
  amountDue: bigint;
  taxBreakdown: AppliedTax[];
  requiresShipping: boolean;
  /** What still blocks placing the order (`items`, `email`, `shippingAddress`, …). */
  missing: string[];
  warnings: string[];
  format: (amount: bigint) => string;
}

/**
 * Prices a cart the way checkout will charge it (PLAN.md §9): price-index prices for the shopper's
 * group and quantity (tiers), bundles from their components, stock per website, cart promotions,
 * shipping (free thresholds and free-shipping promotions), tax for the destination (inclusive or
 * exclusive stores), and loyalty points as a deduction from the amount due. Read-only.
 */
@Injectable()
export class CartPricer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
    private readonly products: ProductsQuery,
    private readonly pricing: PricingQuery,
    private readonly inventory: InventoryQuery,
    private readonly shipping: ShippingQuery,
    private readonly redemptions: RedemptionsService,
    private readonly tax: TaxQuery,
    private readonly customers: CustomersQuery,
    private readonly loyalty: LoyaltyQuery,
  ) {}

  async load(cartId: string): Promise<CartRow> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      select: CART_SELECT,
    });
    if (!cart) throw new NotFoundException('Cart not found');
    return cart;
  }

  async price(
    cartOrId: CartRow | string,
    opts: { localeCode?: string; now?: Date } = {},
  ): Promise<PricedCart> {
    const cart =
      typeof cartOrId === 'string' ? await this.load(cartOrId) : cartOrId;
    const now = opts.now ?? new Date();
    const snap = await this.stores.snapshot();
    const store = snap.byId.get(cart.storeId);
    if (!store)
      throw new NotFoundException('The cart’s store no longer exists');
    const ctx = resolveStoreContext(snap, {
      storeCode: store.code,
      locale: opts.localeCode,
      currency: cart.currencyCode,
      ignoreInactive: true,
    });
    const groupCode =
      (cart.customerId
        ? await this.customers.groupOfCustomer(cart.customerId)
        : undefined) ?? GUEST_GROUP;
    const minor = snap.currencies.get(cart.currencyCode)?.minorUnits ?? 2;
    const format = (amount: bigint) =>
      formatMoney(amount, cart.currencyCode, minor, ctx.localeCode);
    const warnings: string[] = [];

    // ── Lines: facts, components, prices, stock.
    const facts = await this.products.cartLines(
      cart.items.map((i) => i.variantId),
    );
    const components = new Map<string, BundleComponent[]>();
    for (const i of cart.items) {
      const f = facts.get(i.variantId);
      if (f?.type === 'BUNDLE') {
        try {
          components.set(
            i.id,
            resolveBundle(f, i.options as unknown as BundleChoice[]),
          );
        } catch {
          components.set(i.id, []);
        }
      }
    }
    const allVariants = [
      ...new Set([
        ...cart.items.map((i) => i.variantId),
        ...[...components.values()].flat().map((c) => c.variantId),
      ]),
    ];
    const productIds = [
      ...new Set([...facts.values()].map((f) => f.productId)),
    ];
    const [visible, prices, stock, summaries] = await Promise.all([
      this.products.visibleIds(ctx, productIds),
      this.pricing.prices(ctx, allVariants, groupCode),
      this.inventory.salable(ctx.websiteId, allVariants),
      this.products.summaries(ctx, productIds),
    ]);
    const visibleSet = new Set(visible);
    const names = new Map(summaries.map((s) => [s.id, s.name]));
    // Units each variant needs across the cart (a variant can be in several lines and bundles).
    const demand = new Map<string, number>();
    const need = (variantId: string, qty: number) =>
      demand.set(variantId, (demand.get(variantId) ?? 0) + qty);
    for (const i of cart.items) {
      const comps = components.get(i.id);
      if (comps)
        comps.forEach((c) => need(c.variantId, c.quantity * i.quantity));
      else need(i.variantId, i.quantity);
    }
    const stockProblem = (variantId: string): string | null => {
      const s = stock.get(variantId);
      if (!s || !s.managed) return null;
      const wanted = demand.get(variantId) ?? 0;
      return wanted > (s.salable ?? 0)
        ? s.salable
          ? `Only ${s.salable} available`
          : 'Out of stock'
        : null;
    };

    const lines: PricedLine[] = cart.items.map((i) => {
      const f = facts.get(i.variantId);
      const base = {
        itemId: i.id,
        variantId: i.variantId,
        productId: f?.productId ?? null,
        sku: f?.sku ?? 'unknown',
        name: (f && names.get(f.productId)) ?? f?.sku ?? 'Unavailable item',
        type: f?.type ?? 'SIMPLE',
        quantity: i.quantity,
        options: i.options as unknown as BundleChoice[],
        attributes: f?.optionValues ?? {},
        components: components.get(i.id) ?? [],
        unitPrice: 0n,
        rowTotal: 0n,
        discount: 0n,
        taxAmount: 0n,
        taxRate: '0',
        taxClassId: f?.taxClassId ?? null,
      };
      const unavailable = (message: string): PricedLine => ({
        ...base,
        available: false,
        message,
      });
      if (!f || !f.enabled || !visibleSet.has(f.productId))
        return unavailable('No longer available');
      if (f.type === 'GIFT_CARD')
        return unavailable('Gift cards can’t be bought online yet');
      let unit: number;
      if (f.type === 'BUNDLE') {
        const comps = components.get(i.id)!;
        if (!comps.length)
          return unavailable('The bundle’s choices are no longer valid');
        let sum = 0;
        for (const c of comps) {
          const p = prices.get(c.variantId);
          if (!p) return unavailable(`${c.sku} has no price in this store`);
          const problem = stockProblem(c.variantId);
          if (problem) return unavailable(`${c.sku}: ${problem}`);
          sum += unitPriceFor(p, c.quantity * i.quantity) * c.quantity;
        }
        unit = sum;
      } else {
        const p = prices.get(i.variantId);
        if (!p) return unavailable('Not sold in this store');
        const problem = stockProblem(i.variantId);
        if (problem) return unavailable(problem);
        unit = unitPriceFor(p, i.quantity);
      }
      return {
        ...base,
        unitPrice: BigInt(unit),
        rowTotal: BigInt(unit) * BigInt(i.quantity),
        available: true,
        message: null,
      };
    });
    const sellable = lines.filter((l) => l.available);
    if (sellable.length < lines.length)
      warnings.push(
        'Some items can’t be bought right now; remove or change them to check out',
      );

    // ── Promotions (shipping is decided after the discount, so evaluate first).
    const engineLines: CartLine[] = sellable.map((l) => ({
      key: l.itemId,
      sku: l.sku,
      productId: l.productId!,
      categoryIds: facts.get(l.variantId)?.categoryIds ?? [],
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    }));
    const evaluation = await this.redemptions.evaluateLines(
      {
        websiteId: ctx.websiteId,
        currencyCode: cart.currencyCode,
        customerGroupCode: groupCode,
        customerId: cart.customerId,
        couponCode: cart.couponCode,
        lines: engineLines,
        shippingAmount: 0n,
        localeChain: ctx.localeChain,
      },
      now,
    );
    const discountOf = new Map(
      evaluation.result.lines.map((l) => [l.key, l.discount]),
    );
    for (const l of sellable) l.discount = discountOf.get(l.itemId) ?? 0n;
    const subtotal = sellable.reduce((s, l) => s + l.rowTotal, 0n);
    const discountTotal = sellable.reduce((s, l) => s + l.discount, 0n);

    // ── Shipping.
    const requiresShipping = sellable.some((l) => SHIPPABLE.has(l.type));
    const address = cart.shippingAddress as unknown as AddressInput | null;
    const shippingOptions = requiresShipping
      ? await this.shipping.options({
          websiteId: ctx.websiteId,
          currencyCode: cart.currencyCode,
          countryCode: address?.countryCode ?? null,
          units: sellable
            .filter((l) => SHIPPABLE.has(l.type))
            .reduce((n, l) => n + l.quantity, 0),
          discountedSubtotal: subtotal - discountTotal,
          localeChain: ctx.localeChain,
        })
      : [];
    const shipping =
      (requiresShipping &&
        shippingOptions.find((o) => o.id === cart.shippingMethodId)) ||
      null;
    if (requiresShipping && cart.shippingMethodId && !shipping)
      warnings.push(
        'The chosen shipping method doesn’t serve this cart any more',
      );
    const shippingAmount = shipping?.amount ?? 0n;
    const shippingDiscount = evaluation.result.freeShipping
      ? shippingAmount
      : 0n;

    // ── Tax for the destination (shipping address, else the store's country).
    const group = await this.customers.groupByCode(groupCode);
    const customerTaxClassId = await this.tax.classId(
      group.taxClassId,
      'CUSTOMER',
    );
    const taxLines = [];
    for (const l of sellable)
      taxLines.push({
        key: l.itemId,
        amount: l.rowTotal - l.discount,
        productTaxClassId: await this.tax.classId(l.taxClassId, 'PRODUCT'),
      });
    if (shipping?.taxClassId && shippingAmount - shippingDiscount > 0n)
      taxLines.push({
        key: '__shipping',
        amount: shippingAmount - shippingDiscount,
        productTaxClassId: shipping.taxClassId,
      });
    const taxResult = await this.tax.calculate({
      lines: taxLines,
      destination: address
        ? {
            countryCode: address.countryCode,
            regionCode: address.regionCode ?? null,
            postcode: address.postcode ?? null,
          }
        : { countryCode: ctx.countryCode },
      customerTaxClassId,
      pricesIncludeTax: ctx.pricesIncludeTax,
      date: now,
    });
    const taxOf = new Map(taxResult.lines.map((l) => [l.key, l]));
    for (const l of sellable) {
      const t = taxOf.get(l.itemId);
      l.taxAmount = t?.tax ?? 0n;
      l.taxRate = (t?.taxes ?? [])
        .reduce((sum, x) => sum + Number(x.rate), 0)
        .toFixed(4);
    }
    const shippingTax = taxOf.get('__shipping')?.tax ?? 0n;
    const taxTotal = taxResult.totals.tax;
    const grandTotal =
      subtotal -
      discountTotal +
      shippingAmount -
      shippingDiscount +
      (ctx.pricesIncludeTax ? 0n : taxTotal);

    // ── Loyalty points pay part of the order (a tender, after tax).
    let loyaltyPoints = 0;
    let loyaltyAmount = 0n;
    if (cart.loyaltyPoints > 0 && cart.customerId) {
      const terms = await this.loyalty.redemptionTerms(cart.customerId);
      if (!terms || terms.currencyCode !== cart.currencyCode)
        warnings.push('Points can’t be used for this cart');
      else {
        const cap = (grandTotal * BigInt(terms.maxRedeemPercent)) / 100n;
        loyaltyPoints = Math.min(
          cart.loyaltyPoints,
          terms.balance,
          Number(cap / terms.pointValue),
        );
        if (loyaltyPoints < terms.minRedeemPoints) loyaltyPoints = 0;
        if (loyaltyPoints !== cart.loyaltyPoints)
          warnings.push(
            loyaltyPoints
              ? `Only ${loyaltyPoints} points can be used for this cart`
              : 'Not enough points can be used for this cart',
          );
        loyaltyAmount = BigInt(loyaltyPoints) * terms.pointValue;
      }
    }

    const missing: string[] = [];
    if (!sellable.length || sellable.length < lines.length)
      missing.push('items');
    if (!cart.customerId && !cart.email) missing.push('email');
    if (requiresShipping && !address) missing.push('shippingAddress');
    if (requiresShipping && !shipping) missing.push('shippingMethod');
    if (
      sellable.length &&
      !requiresShipping &&
      !address &&
      !cart.billingAddress
    )
      missing.push('billingAddress');
    if (evaluation.coupon && evaluation.coupon.status !== 'APPLIED')
      warnings.push(evaluation.coupon.message);

    return {
      cart,
      ctx,
      customerGroupCode: groupCode,
      lines,
      evaluation,
      shippingOptions,
      shipping,
      shippingAmount,
      shippingDiscount,
      shippingTax,
      subtotal,
      discountTotal,
      taxTotal,
      grandTotal,
      loyaltyPoints,
      loyaltyAmount,
      amountDue: grandTotal - loyaltyAmount,
      taxBreakdown: taxResult.taxes,
      requiresShipping,
      missing,
      warnings,
      format,
    };
  }
}
