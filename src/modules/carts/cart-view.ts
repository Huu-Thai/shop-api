import type { AddressInput, PricedCart } from './cart-pricer.js';
import type { CartAddressViewDto, CartDto, MoneyDto } from './dto/cart.dto.js';

const address = (a: unknown): CartAddressViewDto | null => {
  if (!a) return null;
  const x = a as AddressInput;
  return {
    firstName: x.firstName,
    lastName: x.lastName,
    company: x.company ?? null,
    phone: x.phone ?? null,
    countryCode: x.countryCode,
    regionCode: x.regionCode ?? null,
    city: x.city,
    postcode: x.postcode ?? null,
    line1: x.line1,
    line2: x.line2 ?? null,
  };
};

/** The storefront shape of a priced cart. */
export function cartView(p: PricedCart, token?: string): CartDto {
  const money = (amount: bigint): MoneyDto => ({
    amount: Number(amount),
    formatted: p.format(amount),
  });
  return {
    id: p.cart.id,
    ...(token ? { token } : {}),
    currency: p.cart.currencyCode,
    email: p.cart.email,
    items: p.lines.map((l) => ({
      id: l.itemId,
      sku: l.sku,
      name: l.name,
      productId: l.productId,
      variantId: l.variantId,
      type: l.type,
      quantity: l.quantity,
      attributes: l.attributes,
      options: l.options.map((o) => ({
        option: o.option,
        sku: o.sku,
        quantity: o.quantity ?? 1,
      })),
      unitPrice: money(l.unitPrice),
      rowTotal: money(l.rowTotal),
      discount: money(l.discount),
      tax: money(l.taxAmount),
      available: l.available,
      message: l.message,
    })),
    itemCount: p.lines.reduce((n, l) => n + l.quantity, 0),
    coupon: p.evaluation.coupon
      ? {
          code: p.evaluation.coupon.code,
          status: p.evaluation.coupon.status,
          message: p.evaluation.coupon.message,
        }
      : null,
    promotions: p.evaluation.result.applied.map((a) => ({
      label: a.label,
      discount: money(a.discount),
      freeShipping: a.freeShipping,
    })),
    shippingAddress: address(p.cart.shippingAddress),
    billingAddress: address(p.cart.billingAddress ?? p.cart.shippingAddress),
    requiresShipping: p.requiresShipping,
    shippingMethod: p.shipping
      ? {
          code: p.shipping.code,
          carrier: p.shipping.carrier,
          name: p.shipping.name,
          description: p.shipping.description,
          price: money(p.shippingAmount - p.shippingDiscount),
        }
      : null,
    loyaltyPoints: p.loyaltyPoints,
    totals: {
      subtotal: money(p.subtotal),
      discount: money(p.discountTotal),
      shipping: money(p.shippingAmount - p.shippingDiscount),
      tax: money(p.taxTotal),
      grandTotal: money(p.grandTotal),
      loyalty: money(p.loyaltyAmount),
      amountDue: money(p.amountDue),
      pricesIncludeTax: p.ctx.pricesIncludeTax,
    },
    missing: p.missing,
    warnings: p.warnings,
    version: p.cart.version,
  };
}
