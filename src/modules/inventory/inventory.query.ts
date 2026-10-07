import { Injectable } from '@nestjs/common';
import type { ProductType } from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ProductsQuery } from '../products/products.query.js';

/** Product types without physical stock: always available, nothing is reserved. */
export const UNMANAGED_TYPES: ReadonlySet<ProductType> = new Set([
  'VIRTUAL',
  'GIFT_CARD',
  'BUNDLE',
]);

export interface Salable {
  managed: boolean;
  /** null when stock is not managed. */
  salable: number | null;
  inStock: boolean;
}

/** Salable quantity per website (sum over its active sources of quantity − reserved − safety). */
@Injectable()
export class InventoryQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsQuery,
  ) {}

  async salable(
    websiteId: string,
    variantIds: readonly string[],
  ): Promise<Map<string, Salable>> {
    const out = new Map<string, Salable>();
    if (!variantIds.length) return out;
    const info = await this.products.variantTaxInfo(variantIds);
    const managed = variantIds.filter(
      (id) => info.has(id) && !UNMANAGED_TYPES.has(info.get(id)!.type),
    );
    for (const id of variantIds)
      if (info.has(id) && !managed.includes(id))
        out.set(id, { managed: false, salable: null, inStock: true });
    if (!managed.length) return out;
    const rows = await this.prisma.$queryRaw<
      { variant_id: string; salable: number }[]
    >`
      SELECT i.variant_id, SUM(GREATEST(0, i.quantity - i.reserved - i.safety_stock))::int AS salable
        FROM inventories i
        JOIN website_inventory_sources w ON w.source_id = i.source_id AND w.website_id = ${websiteId}::uuid
        JOIN inventory_sources s ON s.id = i.source_id AND s.is_active
       WHERE i.variant_id = ANY (${managed}::uuid[])
       GROUP BY i.variant_id`;
    const qty = new Map(rows.map((r) => [r.variant_id, r.salable]));
    for (const id of managed) {
      const n = qty.get(id) ?? 0;
      out.set(id, { managed: true, salable: n, inStock: n > 0 });
    }
    return out;
  }

  /** True when the variant's stock is tracked (physical goods). */
  async isManaged(variantId: string): Promise<boolean | undefined> {
    const v = (await this.products.variantTaxInfo([variantId])).get(variantId);
    return v ? !UNMANAGED_TYPES.has(v.type) : undefined;
  }
}
