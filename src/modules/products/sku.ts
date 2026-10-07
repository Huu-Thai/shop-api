import { ConflictException } from '@nestjs/common';
import type { PrismaTransaction } from '../../database/prisma.service.js';

/**
 * SKUs identify sellable units in orders and stock, so one SKU means one thing across products and
 * variants. The only shared SKU is a single-variant product and its own default variant.
 */
export async function assertSkusFree(
  tx: PrismaTransaction,
  skus: readonly string[],
  ownerProductId?: string,
): Promise<void> {
  if (!skus.length) return;
  const [products, variants] = await Promise.all([
    tx.product.findMany({
      where: {
        sku: { in: [...skus] },
        ...(ownerProductId ? { id: { not: ownerProductId } } : {}),
      },
      select: { sku: true },
    }),
    tx.productVariant.findMany({
      where: {
        sku: { in: [...skus] },
        ...(ownerProductId ? { productId: { not: ownerProductId } } : {}),
      },
      select: { sku: true },
    }),
  ]);
  const taken = [...new Set([...products, ...variants].map((r) => r.sku))];
  if (taken.length)
    throw new ConflictException(
      taken.map(
        (s) => `SKU ${s} is already used by another product or variant`,
      ),
    );
}
