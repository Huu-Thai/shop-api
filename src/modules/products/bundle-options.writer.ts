import { BadRequestException, Injectable } from '@nestjs/common';
import { assertUniqueLocales } from '../../common/dto/translation.dto.js';
import type { PrismaTransaction } from '../../database/prisma.service.js';
import type { BundleOptionInputDto } from './dto/product-input.dto.js';
import { BUNDLEABLE_TYPES, bundleOptionErrors } from './product-types.js';

/** Replaces a bundle's options inside the caller's transaction (used by create and PUT). */
@Injectable()
export class BundleOptionsWriter {
  async replace(
    tx: PrismaTransaction,
    productId: string,
    options: BundleOptionInputDto[],
  ): Promise<void> {
    const errors: string[] = [];
    if (new Set(options.map((o) => o.code)).size !== options.length)
      errors.push('Duplicate bundle option code');
    for (const o of options) {
      errors.push(...bundleOptionErrors(o));
      assertUniqueLocales(o.titles, `bundleOptions[${o.code}].titles`);
    }
    const variantIds = [
      ...new Set(options.flatMap((o) => o.selections.map((s) => s.variantId))),
    ];
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        sku: true,
        product: { select: { id: true, type: true, deletedAt: true } },
      },
    });
    for (const id of variantIds) {
      const v = variants.find((x) => x.id === id);
      if (!v || v.product.deletedAt)
        errors.push(`Variant ${id} does not exist`);
      else if (v.product.id === productId)
        errors.push('A bundle cannot contain itself');
      else if (!BUNDLEABLE_TYPES.has(v.product.type))
        errors.push(
          `Variant ${v.sku} belongs to a ${v.product.type} product, which cannot be bundled`,
        );
    }
    if (errors.length) throw new BadRequestException(errors);

    await tx.bundleOption.deleteMany({ where: { productId } });
    for (const [i, o] of options.entries())
      await tx.bundleOption.create({
        data: {
          productId,
          code: o.code,
          inputType: o.inputType,
          isRequired: o.isRequired ?? true,
          position: o.position ?? i,
          translations: {
            create: o.titles.map(({ localeCode, title }) => ({
              localeCode,
              title,
            })),
          },
          selections: {
            create: o.selections.map((s, j) => ({
              variantId: s.variantId,
              qty: s.qty ?? 1,
              canChangeQty: s.canChangeQty ?? false,
              isDefault: s.isDefault ?? false,
              position: s.position ?? j,
            })),
          },
        },
      });
  }
}
