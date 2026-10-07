import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sha256 } from '../../common/auth/api-key-format.js';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../database/generated/prisma/client.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../database/prisma.service.js';
import { CustomersQuery } from '../customers/customers.query.js';
import { InventoryQuery } from '../inventory/inventory.query.js';
import { LoyaltyQuery } from '../loyalty/loyalty.query.js';
import { ProductsQuery } from '../products/products.query.js';
import type { StoreContext } from '../stores/context/store-context.js';
import {
  type AddressInput,
  CART_SELECT,
  type CartRow,
  CartPricer,
  type PricedCart,
} from './cart-pricer.js';
import {
  type BundleChoice,
  choicesSignature,
  resolveBundle,
} from './cart-math.js';
import { CART_EVENTS } from './carts.events.js';
import type {
  AddCartItemDto,
  CartAddressDto,
  SetAddressesDto,
} from './dto/cart.dto.js';

export const CART_TOKEN_HEADER = 'x-cart-token';
const MAX_LINES = 100;

const ADDRESS_FIELDS = [
  'firstName',
  'lastName',
  'countryCode',
  'city',
  'line1',
] as const;

/**
 * Carts (PLAN.md §7.1): a guest's cart is found by an opaque token (sent as `X-Cart-Token`, stored
 * hashed), a customer's by their session — one active cart per customer and store. Every change
 * bumps `version`; prices are never stored on the cart, they are worked out by CartPricer.
 */
@Injectable()
export class CartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly pricer: CartPricer,
    private readonly products: ProductsQuery,
    private readonly inventory: InventoryQuery,
    private readonly loyalty: LoyaltyQuery,
    private readonly customers: CustomersQuery,
  ) {}

  /** The request's active cart, if any. */
  async current(ctx: StoreContext, token?: string): Promise<CartRow | null> {
    const where: Prisma.CartWhereInput | null = ctx.customer
      ? { storeId: ctx.storeId, customerId: ctx.customer.id, status: 'ACTIVE' }
      : token
        ? { storeId: ctx.storeId, tokenHash: sha256(token), status: 'ACTIVE' }
        : null;
    if (!where) return null;
    return this.prisma.cart.findFirst({ where, select: CART_SELECT });
  }

  async require(ctx: StoreContext, token?: string): Promise<CartRow> {
    const cart = await this.current(ctx, token);
    if (!cart)
      throw new NotFoundException(
        'No cart: create one with POST /store/cart (guests send its token as X-Cart-Token)',
      );
    return cart;
  }

  /** A customer's existing cart, or a new one (guests get a new cart and its token, once). */
  async create(ctx: StoreContext): Promise<{ cart: CartRow; token?: string }> {
    if (ctx.customer) {
      const existing = await this.current(ctx);
      if (existing) return { cart: existing };
    }
    const token = ctx.customer
      ? undefined
      : randomBytes(32).toString('base64url');
    const cart = await this.bus.write({
      before: this.before('create', null),
      work: async (tx, after) => {
        const c = await tx.cart.create({
          data: {
            storeId: ctx.storeId,
            customerId: ctx.customer?.id ?? null,
            tokenHash: token ? sha256(token) : null,
            currencyCode: ctx.currencyCode,
          },
          select: CART_SELECT,
        });
        after.add(new ProjectionEvent(CART_EVENTS.CREATED, { cartId: c.id }));
        return c;
      },
    });
    return { cart, token };
  }

  /** Customers get a cart on their first change; guests must create one first. */
  private async cartForChange(
    ctx: StoreContext,
    token?: string,
  ): Promise<CartRow> {
    return (
      (await this.current(ctx, token)) ??
      (ctx.customer
        ? (await this.create(ctx)).cart
        : await this.require(ctx, token))
    );
  }

  async addItem(
    ctx: StoreContext,
    token: string | undefined,
    dto: AddCartItemDto,
  ): Promise<CartRow> {
    const cart = await this.cartForChange(ctx, token);
    const variantId = (await this.products.variantIdsBySku([dto.sku])).get(
      dto.sku,
    );
    if (!variantId) throw new NotFoundException(`Unknown SKU ${dto.sku}`);
    const facts = (await this.products.cartLines([variantId])).get(variantId);
    if (
      !facts ||
      !facts.enabled ||
      !(await this.products.visibleIds(ctx, [facts.productId])).length
    )
      throw new BadRequestException(`${dto.sku} is not sold in this store`);
    if (facts.type === 'GIFT_CARD')
      throw new BadRequestException('Gift cards can’t be bought online yet');
    let options: BundleChoice[] = [];
    let signature = '';
    let needs: { variantId: string; quantity: number }[] = [
      { variantId, quantity: dto.quantity },
    ];
    if (facts.type === 'BUNDLE') {
      const components = resolveBundle(facts, dto.options ?? []);
      options = components.map((c) => ({
        option: c.option,
        sku: c.sku,
        quantity: c.quantity,
      }));
      signature = choicesSignature(components);
      needs = components.map((c) => ({
        variantId: c.variantId,
        quantity: c.quantity * dto.quantity,
      }));
    } else if (dto.options?.length)
      throw new BadRequestException(`${dto.sku} has no options to choose`);
    const existing = cart.items.find(
      (i) => i.variantId === variantId && i.signature === signature,
    );
    await this.assertStock(ctx, needs, existing?.quantity ?? 0);
    if (!existing && cart.items.length >= MAX_LINES)
      throw new BadRequestException(`A cart holds at most ${MAX_LINES} lines`);
    return this.change(cart.id, 'add-item', async (tx) => {
      if (existing)
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: { increment: dto.quantity } },
        });
      else
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            variantId,
            quantity: dto.quantity,
            options: options as unknown as Prisma.InputJsonValue,
            signature,
          },
        });
    });
  }

  async updateItem(
    ctx: StoreContext,
    token: string | undefined,
    itemId: string,
    quantity: number,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    const item = cart.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException(`Cart item ${itemId} not found`);
    if (quantity > item.quantity) {
      const facts = (await this.products.cartLines([item.variantId])).get(
        item.variantId,
      );
      const needs =
        facts?.type === 'BUNDLE'
          ? resolveBundle(facts, item.options as unknown as BundleChoice[]).map(
              (c) => ({
                variantId: c.variantId,
                quantity: c.quantity * (quantity - item.quantity),
              }),
            )
          : [{ variantId: item.variantId, quantity: quantity - item.quantity }];
      await this.assertStock(ctx, needs, item.quantity);
    }
    return this.change(cart.id, 'update-item', (tx) =>
      tx.cartItem.update({ where: { id: itemId }, data: { quantity } }),
    );
  }

  async removeItem(
    ctx: StoreContext,
    token: string | undefined,
    itemId: string,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    if (!cart.items.some((i) => i.id === itemId))
      throw new NotFoundException(`Cart item ${itemId} not found`);
    return this.change(cart.id, 'remove-item', (tx) =>
      tx.cartItem.delete({ where: { id: itemId } }),
    );
  }

  /** Only a coupon that applies to the cart now is accepted. */
  async setCoupon(
    ctx: StoreContext,
    token: string | undefined,
    code: string | null,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    if (code) {
      const priced = await this.pricer.price(
        { ...cart, couponCode: code },
        { localeCode: ctx.localeCode },
      );
      const coupon = priced.evaluation.coupon;
      if (!coupon || coupon.status !== 'APPLIED')
        throw new BadRequestException(
          coupon?.message ?? 'This coupon code is not valid',
        );
      code = coupon.code;
    }
    return this.change(cart.id, code ? 'set-coupon' : 'remove-coupon', (tx) =>
      tx.cart.update({ where: { id: cart.id }, data: { couponCode: code } }),
    );
  }

  async setEmail(
    ctx: StoreContext,
    token: string | undefined,
    email: string,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    return this.change(cart.id, 'set-email', (tx) =>
      tx.cart.update({ where: { id: cart.id }, data: { email } }),
    );
  }

  async setAddresses(
    ctx: StoreContext,
    token: string | undefined,
    dto: SetAddressesDto,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    if (!dto.shipping && !dto.billing)
      throw new BadRequestException('Send a shipping and/or a billing address');
    const shipping = dto.shipping
      ? await this.address(ctx, dto.shipping, 'shipping')
      : undefined;
    const billing = dto.billing
      ? await this.address(ctx, dto.billing, 'billing')
      : undefined;
    return this.change(cart.id, 'set-addresses', (tx) =>
      tx.cart.update({
        where: { id: cart.id },
        data: {
          ...(shipping
            ? { shippingAddress: shipping as unknown as Prisma.InputJsonValue }
            : {}),
          ...(billing
            ? { billingAddress: billing as unknown as Prisma.InputJsonValue }
            : {}),
        },
      }),
    );
  }

  async setShippingMethod(
    ctx: StoreContext,
    token: string | undefined,
    code: string,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    const priced = await this.pricer.price(cart, {
      localeCode: ctx.localeCode,
    });
    const option = priced.shippingOptions.find((o) => o.code === code);
    if (!option)
      throw new BadRequestException(
        priced.requiresShipping
          ? `Shipping method "${code}" is not available for this cart`
          : 'This cart has nothing to ship',
      );
    return this.change(cart.id, 'set-shipping-method', (tx) =>
      tx.cart.update({
        where: { id: cart.id },
        data: { shippingMethodId: option.id },
      }),
    );
  }

  async setLoyaltyPoints(
    ctx: StoreContext,
    token: string | undefined,
    points: number,
  ): Promise<CartRow> {
    const cart = await this.require(ctx, token);
    if (points > 0) {
      if (!ctx.customer) throw new BadRequestException('Sign in to use points');
      const terms = await this.loyalty.redemptionTerms(ctx.customer.id);
      if (!terms)
        throw new BadRequestException('You have no points to use here');
      if (terms.currencyCode !== cart.currencyCode)
        throw new BadRequestException(
          `Points pay for ${terms.currencyCode} orders only`,
        );
      if (points < terms.minRedeemPoints)
        throw new BadRequestException(
          `Use at least ${terms.minRedeemPoints} points`,
        );
      if (points > terms.balance)
        throw new BadRequestException(
          `Only ${terms.balance} points are available`,
        );
    }
    return this.change(cart.id, points ? 'set-points' : 'remove-points', (tx) =>
      tx.cart.update({
        where: { id: cart.id },
        data: { loyaltyPoints: points },
      }),
    );
  }

  /** Signing in: the guest cart's lines move into the customer's cart (quantities add up). */
  async merge(ctx: StoreContext, guestToken: string): Promise<CartRow> {
    if (!ctx.customer) throw new BadRequestException('Sign in to merge a cart');
    const guest = await this.prisma.cart.findFirst({
      where: {
        storeId: ctx.storeId,
        tokenHash: sha256(guestToken),
        status: 'ACTIVE',
        customerId: null,
      },
      select: CART_SELECT,
    });
    const target = await this.cartForChange(ctx);
    if (!guest) return target;
    return this.change(target.id, 'merge', async (tx, after) => {
      for (const g of guest.items) {
        const same = target.items.find(
          (t) => t.variantId === g.variantId && t.signature === g.signature,
        );
        if (same)
          await tx.cartItem.update({
            where: { id: same.id },
            data: { quantity: { increment: g.quantity } },
          });
        else
          await tx.cartItem.create({
            data: {
              cartId: target.id,
              variantId: g.variantId,
              quantity: g.quantity,
              options: g.options as Prisma.InputJsonValue,
              signature: g.signature,
            },
          });
      }
      await tx.cart.update({
        where: { id: target.id },
        data: {
          couponCode: target.couponCode ?? guest.couponCode,
          email: target.email ?? guest.email,
          shippingAddress: (target.shippingAddress ??
            guest.shippingAddress ??
            undefined) as Prisma.InputJsonValue | undefined,
          billingAddress: (target.billingAddress ??
            guest.billingAddress ??
            undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      await tx.cart.update({
        where: { id: guest.id },
        data: { status: 'MERGED' },
      });
      after.add(
        new ProjectionEvent(CART_EVENTS.MERGED, {
          cartId: target.id,
          from: guest.id,
        }),
      );
    });
  }

  /** The cart became an order (order.placed listener). Idempotent. */
  async convert(cartId: string, orderId: string): Promise<void> {
    await this.bus.write({
      before: this.before('convert', cartId),
      work: async (tx, after) => {
        const { count } = await tx.cart.updateMany({
          where: { id: cartId, status: 'ACTIVE' },
          data: { status: 'CONVERTED', version: { increment: 1 } },
        });
        if (count)
          after.add(
            new ProjectionEvent(CART_EVENTS.CONVERTED, { cartId, orderId }),
          );
      },
    });
  }

  /** Daily: forgets abandoned guest carts and stale converted/merged carts. */
  async purge(
    now = new Date(),
    guestDays = 30,
    otherDays = 90,
  ): Promise<number> {
    const day = 86_400_000;
    return this.bus.write({
      before: this.before('purge', null),
      work: async (tx) =>
        (
          await tx.cart.deleteMany({
            where: {
              OR: [
                {
                  customerId: null,
                  updatedAt: { lt: new Date(now.getTime() - guestDays * day) },
                },
                {
                  status: { not: 'ACTIVE' },
                  updatedAt: { lt: new Date(now.getTime() - otherDays * day) },
                },
              ],
            },
          })
        ).count,
    });
  }

  price(cart: CartRow, ctx: StoreContext): Promise<PricedCart> {
    return this.pricer.price(cart, { localeCode: ctx.localeCode });
  }

  // ─── internals ───

  private before(action: string, cartId: string | null) {
    return new BeforeWriteEvent(
      CART_EVENTS.BEFORE_WRITE,
      action,
      cartId,
      SYSTEM_ACTOR,
    );
  }

  private async change(
    cartId: string,
    action: string,
    work: (
      tx: PrismaTransaction,
      after: { add: (e: ProjectionEvent) => void },
    ) => Promise<unknown>,
  ): Promise<CartRow> {
    return this.bus.write({
      before: this.before(action, cartId),
      work: async (tx, after) => {
        await work(tx, after);
        const c = await tx.cart.update({
          where: { id: cartId },
          data: { version: { increment: 1 } },
          select: CART_SELECT,
        });
        after.add(new ProjectionEvent(CART_EVENTS.UPDATED, { cartId, action }));
        return c;
      },
    });
  }

  private async assertStock(
    ctx: StoreContext,
    needs: readonly { variantId: string; quantity: number }[],
    alreadyInCart: number,
  ): Promise<void> {
    const stock = await this.inventory.salable(
      ctx.websiteId,
      needs.map((n) => n.variantId),
    );
    for (const n of needs) {
      const s = stock.get(n.variantId);
      if (
        s?.managed &&
        (s.salable ?? 0) < n.quantity + (needs.length === 1 ? alreadyInCart : 0)
      )
        throw new ConflictException(
          s.salable ? `Only ${s.salable} available` : 'Out of stock',
        );
    }
  }

  private async address(
    ctx: StoreContext,
    dto: CartAddressDto,
    which: string,
  ): Promise<AddressInput> {
    if (dto.addressId) {
      if (!ctx.customer)
        throw new BadRequestException('Sign in to use your address book');
      const a = await this.customers.address(ctx.customer.id, dto.addressId);
      if (!a) throw new NotFoundException(`Address ${dto.addressId} not found`);
      return a;
    }
    const missing = ADDRESS_FIELDS.filter((f) => !dto[f]);
    if (missing.length)
      throw new BadRequestException(
        missing.map((f) => `${which}.${f} is required`),
      );
    return {
      firstName: dto.firstName!,
      lastName: dto.lastName!,
      company: dto.company || null,
      phone: dto.phone || null,
      countryCode: dto.countryCode!,
      regionCode: dto.regionCode || null,
      city: dto.city!,
      postcode: dto.postcode || null,
      line1: dto.line1!,
      line2: dto.line2 || null,
    };
  }
}
