import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { diff } from '../../common/events/audited.event.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type AttributeDef } from '../catalog/attribute-values.js';
import { AttributesQuery } from '../catalog/attributes.query.js';
import { BundleOptionsWriter } from './bundle-options.writer.js';
import type {
  SetBundleOptionsDto,
  UpdateVariantDto,
  VariantInputDto,
} from './dto/product-input.dto.js';
import type { ProductDto, VariantDto } from './dto/product-view.dto.js';
import { validateVariantOptions } from './product-types.js';
import { PRODUCT_EVENTS, type ProductEventData } from './products.events.js';
import { assertSkusFree } from './sku.js';
import { ProductsService } from './products.service.js';

const VARIANT = {
  id: true,
  sku: true,
  optionValues: true,
  isDefault: true,
  status: true,
  weightGrams: true,
  position: true,
} as const;
const toVariant = (
  v: { optionValues: unknown } & Omit<VariantDto, 'optionValues'>,
): VariantDto => ({
  ...v,
  optionValues: v.optionValues as Record<string, string>,
});

/** Configurable variants and bundle options (the sub-resources of a product). */
@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly attributes: AttributesQuery,
    private readonly bundles: BundleOptionsWriter,
    private readonly products: ProductsService,
  ) {}

  /** The configurable product and its axis definitions. */
  private async configurable(productId: string): Promise<AttributeDef[]> {
    const p = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        type: true,
        deletedAt: true,
        configurableAttributes: {
          select: { attributeId: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!p || p.deletedAt)
      throw new NotFoundException(`Product ${productId} not found`);
    if (p.type !== 'CONFIGURABLE')
      throw new BadRequestException(
        'Only CONFIGURABLE products have editable variants; edit the product itself',
      );
    const defs = await this.attributes.byIds(
      p.configurableAttributes.map((c) => c.attributeId),
    );
    return p.configurableAttributes.map((c) => defs.get(c.attributeId)!);
  }

  async create(
    productId: string,
    dto: VariantInputDto,
    actor: Principal,
  ): Promise<VariantDto> {
    const axes = await this.configurable(productId);
    const r = validateVariantOptions(axes, dto.options);
    if (r.errors.length) throw new BadRequestException(r.errors);
    return this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'variant-create',
        productId,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        await assertSkusFree(tx, [dto.sku]);
        const v = await tx.productVariant.create({
          data: {
            productId,
            sku: dto.sku,
            optionValues: r.values,
            optionSignature: r.signature,
            status: dto.status ?? 'ENABLED',
            weightGrams: dto.weightGrams ?? null,
            position:
              dto.position ??
              (await tx.productVariant.count({ where: { productId } })),
          },
          select: VARIANT,
        });
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.VARIANT_CREATED,
            actorOf(actor),
            'product',
            productId,
            { variant: v.sku, options: r.values },
            {
              productId,
              variantId: v.id,
              urlsChanged: false,
            },
          ),
        );
        return toVariant(v);
      },
    });
  }

  async update(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    actor: Principal,
  ): Promise<VariantDto> {
    const axes = await this.configurable(productId);
    const r = dto.options
      ? validateVariantOptions(axes, dto.options)
      : undefined;
    if (r?.errors.length) throw new BadRequestException(r.errors);
    return this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'variant-update',
        productId,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        const before = await tx.productVariant.findFirst({
          where: { id: variantId, productId },
          select: VARIANT,
        });
        if (!before)
          throw new NotFoundException(`Variant ${variantId} not found`);
        const v = await tx.productVariant.update({
          where: { id: variantId },
          data: {
            sku: dto.sku,
            status: dto.status,
            weightGrams: dto.weightGrams,
            position: dto.position,
            ...(r
              ? { optionValues: r.values, optionSignature: r.signature }
              : {}),
          },
          select: VARIANT,
        });
        const changes = diff(before, v, [
          'sku',
          'optionValues',
          'status',
          'weightGrams',
          'position',
        ]);
        if (Object.keys(changes).length)
          after.add(
            new EntityEvent<ProductEventData>(
              PRODUCT_EVENTS.VARIANT_UPDATED,
              actorOf(actor),
              'product',
              productId,
              { variant: v.sku, ...changes },
              {
                productId,
                variantId,
                urlsChanged: false,
              },
            ),
          );
        return toVariant(v);
      },
    });
  }

  /** Fails with 400 (fk_bundle_selections_variant_id) while a bundle sells the variant. */
  async remove(
    productId: string,
    variantId: string,
    actor: Principal,
  ): Promise<void> {
    await this.configurable(productId);
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'variant-delete',
        productId,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        const v = await tx.productVariant.findFirst({
          where: { id: variantId, productId },
          select: { sku: true },
        });
        if (!v) throw new NotFoundException(`Variant ${variantId} not found`);
        const inBundles = await tx.bundleSelection.count({
          where: { variantId },
        });
        if (inBundles)
          throw new ConflictException(
            `Variant ${v.sku} is sold in ${inBundles} bundle option(s); remove it there first`,
          );
        await tx.productVariant.delete({ where: { id: variantId } });
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.VARIANT_DELETED,
            actorOf(actor),
            'product',
            productId,
            { variant: v.sku },
            {
              productId,
              variantId,
              urlsChanged: false,
            },
          ),
        );
      },
    });
  }

  async setBundleOptions(
    productId: string,
    dto: SetBundleOptionsDto,
    actor: Principal,
  ): Promise<ProductDto> {
    const p = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { type: true, deletedAt: true },
    });
    if (!p || p.deletedAt)
      throw new NotFoundException(`Product ${productId} not found`);
    if (p.type !== 'BUNDLE')
      throw new BadRequestException('Only BUNDLE products have bundle options');
    await this.bus.write({
      before: new BeforeWriteEvent(
        PRODUCT_EVENTS.BEFORE_WRITE,
        'bundle-options',
        productId,
        actorOf(actor),
        { slugs: [] },
      ),
      work: async (tx, after) => {
        await this.bundles.replace(tx, productId, dto.options);
        after.add(
          new EntityEvent<ProductEventData>(
            PRODUCT_EVENTS.BUNDLE_CHANGED,
            actorOf(actor),
            'product',
            productId,
            {
              options: dto.options.map((o) => ({
                code: o.code,
                selections: o.selections.length,
              })),
            },
            { productId, urlsChanged: false },
          ),
        );
      },
    });
    return this.products.get(productId);
  }
}
