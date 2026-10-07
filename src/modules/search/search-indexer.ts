import { Injectable, Logger } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import {
  BeforeWriteEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AttributesQuery } from '../catalog/attributes.query.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import { idsInPath } from '../catalog/category-tree.js';
import { ProductsQuery } from '../products/products.query.js';
import { StorefrontCatalogService } from '../storefront/storefront-catalog.service.js';
import { resolveStoreContext } from '../stores/context/store-context.guard.js';
import { type StoreSnapshot, StoresQuery } from '../stores/stores.query.js';
import { buildDocument, weightedText } from './document-builder.js';
import { type DocumentsChangedData, SEARCH_EVENTS } from './search.events.js';
import type { SearchDocumentBody } from './search.types.js';

export const INDEX_BATCH = 100;

/**
 * Maintains `search_documents` (PLAN.md §9.5): one document per product × store × enabled locale,
 * built from the same read models the storefront uses (visibility, translations with fallback,
 * prices, stock), so search and pages never disagree. Writes go through the bus; the
 * documents-changed event pushes them to external engines.
 */
@Injectable()
export class SearchIndexer {
  private readonly logger = new Logger(SearchIndexer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly stores: StoresQuery,
    private readonly products: ProductsQuery,
    private readonly attributes: AttributesQuery,
    private readonly categories: CategoriesQuery,
    private readonly storefront: StorefrontCatalogService,
  ) {}

  async indexProducts(
    productIds: readonly string[],
  ): Promise<{ upserted: number; removed: number }> {
    const ids = [...new Set(productIds)];
    if (!ids.length) return { upserted: 0, removed: 0 };
    const snap = await this.stores.snapshot(true);
    const codes = await this.attributes.searchCodes();
    const attrCodes = [...new Set([...codes.filterable, ...codes.searchable])];
    let upserted = 0;
    let removed = 0;
    for (const store of snap.byId.values())
      for (const localeCode of store.localeCodes.filter(
        (l) => snap.locales.get(l)?.isActive,
      )) {
        const r = await this.indexStoreLocale(
          snap,
          store,
          localeCode,
          ids,
          attrCodes,
        );
        upserted += r.upserted;
        removed += r.removed;
      }
    return { upserted, removed };
  }

  private async indexStoreLocale(
    snap: Awaited<ReturnType<StoresQuery['snapshot']>>,
    store: StoreSnapshot,
    localeCode: string,
    ids: string[],
    attrCodes: string[],
  ) {
    const ctx = resolveStoreContext(snap, {
      storeCode: store.code,
      locale: localeCode,
      ignoreInactive: true,
    });
    const [labels, cards, views] = await Promise.all([
      this.attributes.localized(attrCodes, ctx.localeChain),
      store.isActive ? this.storefront.cards(ctx, ids) : Promise.resolve([]),
      Promise.all(
        ids.map((id) =>
          store.isActive
            ? this.products.view(ctx, id)
            : Promise.resolve(undefined),
        ),
      ),
    ]);
    const visible = views.filter((v): v is NonNullable<typeof v> => !!v);
    const nodes = await this.categories.withAncestors([
      ...new Set(visible.flatMap((v) => v.categoryIds)),
    ]);
    const offers = new Map(
      cards.map((c) => [
        c.id,
        { price: c.price?.amount ?? null, inStock: c.inStock },
      ]),
    );
    const docs: SearchDocumentBody[] = visible.map((v) =>
      buildDocument(
        v,
        offers.get(v.id) ?? { price: null, inStock: false },
        labels,
        v.categoryIds.flatMap((c) =>
          nodes.get(c) ? idsInPath(nodes.get(c)!.path) : [],
        ),
      ),
    );
    const removed = ids.filter((id) => !visible.some((v) => v.id === id));
    await this.write(store.id, localeCode, docs, removed);
    return { upserted: docs.length, removed: removed.length };
  }

  /** Upserts and deletes documents of one store/locale in one transaction. */
  async write(
    storeId: string,
    localeCode: string,
    docs: SearchDocumentBody[],
    removed: string[],
  ): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        SEARCH_EVENTS.DOCUMENTS_BEFORE_WRITE,
        'index',
        storeId,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        for (const d of docs) {
          const w = weightedText(d);
          await tx.$executeRaw`
            INSERT INTO search_documents (store_id, locale_code, entity_type, entity_id, document, search_vector, updated_at)
            VALUES (${storeId}::uuid, ${localeCode}, 'PRODUCT', ${d.id}::uuid, ${JSON.stringify(d)}::jsonb,
                    setweight(to_tsvector(shop_search_config(${localeCode}), shop_unaccent(${w.a})), 'A') ||
                    setweight(to_tsvector(shop_search_config(${localeCode}), shop_unaccent(${w.b})), 'B') ||
                    setweight(to_tsvector(shop_search_config(${localeCode}), shop_unaccent(${w.c})), 'C'),
                    now())
            ON CONFLICT (store_id, locale_code, entity_type, entity_id)
            DO UPDATE SET document = EXCLUDED.document, search_vector = EXCLUDED.search_vector, updated_at = now()`;
        }
        if (removed.length)
          await tx.searchDocument.deleteMany({
            where: {
              storeId,
              localeCode,
              entityType: 'PRODUCT',
              entityId: { in: removed },
            },
          });
        if (docs.length || removed.length)
          after.add(
            new ProjectionEvent<DocumentsChangedData>(
              SEARCH_EVENTS.DOCUMENTS_CHANGED,
              { storeId, localeCode, upserted: docs.map((d) => d.id), removed },
            ),
          );
      },
      timeoutMs: 60_000,
    });
  }

  /** Every product of a website, then documents of products that left it. */
  async reindexWebsite(
    websiteId: string,
  ): Promise<{ products: number; stale: number }> {
    const ids = await this.products.idsOnWebsite(websiteId);
    for (let i = 0; i < ids.length; i += INDEX_BATCH)
      await this.indexProducts(ids.slice(i, i + INDEX_BATCH));
    const stores = (await this.stores.storesOfWebsites([websiteId], true)).map(
      (s) => s.id,
    );
    const stale = await this.prisma.searchDocument.findMany({
      where: {
        storeId: { in: stores },
        entityType: 'PRODUCT',
        entityId: { notIn: ids },
      },
      select: { storeId: true, localeCode: true, entityId: true },
    });
    const groups = new Map<string, string[]>();
    for (const d of stale)
      groups.set(`${d.storeId}|${d.localeCode}`, [
        ...(groups.get(`${d.storeId}|${d.localeCode}`) ?? []),
        d.entityId,
      ]);
    for (const [key, removed] of groups) {
      const [storeId, localeCode] = key.split('|');
      await this.write(storeId, localeCode, [], removed);
    }
    this.logger.log(
      `Search: website ${websiteId} reindexed (${ids.length} products, ${stale.length} stale documents removed)`,
    );
    return { products: ids.length, stale: stale.length };
  }

  /** Products whose documents mention a category (moved or deleted categories). */
  async productsWithCategory(
    categoryIds: readonly string[],
  ): Promise<string[]> {
    if (!categoryIds.length) return [];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT entity_id AS id FROM search_documents WHERE document->'categoryIds' ?| ${[...categoryIds]}::text[]`;
    return rows.map((r) => r.id);
  }
}
