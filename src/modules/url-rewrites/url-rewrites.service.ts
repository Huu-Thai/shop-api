import { InjectQueue } from '@nestjs/bullmq';
import type { Redis } from 'ioredis';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  actorOf,
  type Principal,
  SYSTEM_ACTOR,
} from '../../common/auth/principal.js';
import { paginated, type Paginated } from '../../common/dto/pagination.dto.js';
import {
  BeforeWriteEvent,
  EntityEvent,
  ProjectionEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import type {
  Prisma,
  UrlTargetType,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { COALESCE_DELAY_MS, nextGeneration } from '../../queue/coalesce.js';
import { JOBS, type UrlRewritesRebuildStoreJob } from '../../queue/jobs.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { CategoriesQuery } from '../catalog/categories.query.js';
import { idsInPath } from '../catalog/category-tree.js';
import { ProductsQuery } from '../products/products.query.js';
import { StoresQuery } from '../stores/stores.query.js';
import {
  CreateRedirectDto,
  ListUrlRewritesQueryDto,
  UrlRewriteDto,
} from './dto/url-rewrite.dto.js';
import {
  categoryPath,
  type DesiredPath,
  desiredPaths,
  normalizePath,
  planRewrites,
  productPath,
} from './url-paths.js';
import {
  URL_REWRITE_EVENTS,
  type UrlRewritesRebuiltData,
} from './url-rewrites.events.js';

export const storeGenerationKey = (storeId: string) =>
  `url-rewrites:store-generation:${storeId}`;

const SELECT = {
  id: true,
  storeId: true,
  localeCode: true,
  requestPath: true,
  targetType: true,
  targetId: true,
  targetPath: true,
  redirectType: true,
  isSystem: true,
  updatedAt: true,
} as const satisfies Prisma.UrlRewriteSelect;

/**
 * The URL rewrite projection (PLAN.md §3.2): system rows are derived from product/category slugs and
 * website assignment, per store and locale; custom rows are admin redirects.
 */
@Injectable()
export class UrlRewritesService {
  private readonly logger = new Logger(UrlRewritesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly stores: StoresQuery,
    private readonly products: ProductsQuery,
    private readonly categories: CategoriesQuery,
    @InjectQueue(QUEUES.CATALOG)
    private readonly queue: Queue<UrlRewritesRebuildStoreJob>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async list(q: ListUrlRewritesQueryDto): Promise<Paginated<UrlRewriteDto>> {
    const where: Prisma.UrlRewriteWhereInput = {
      storeId: q.storeId,
      localeCode: q.localeCode,
      targetType: q.targetType,
      targetId: q.targetId,
      ...(q.search
        ? { requestPath: { contains: normalizePath(q.search) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.urlRewrite.findMany({
        where,
        select: SELECT,
        orderBy: [{ updatedAt: q.order }, { requestPath: 'asc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.urlRewrite.count({ where }),
    ]);
    return paginated(rows, total, q);
  }

  /** Admin redirect (`/summer-sale` → `/women/dresses`). Can't shadow a canonical URL. */
  async createRedirect(
    dto: CreateRedirectDto,
    actor: Principal,
  ): Promise<UrlRewriteDto> {
    const requestPath = normalizePath(dto.requestPath);
    if (!requestPath)
      throw new BadRequestException('requestPath must not be empty');
    return this.bus.write({
      before: new BeforeWriteEvent(
        URL_REWRITE_EVENTS.BEFORE_WRITE,
        'create',
        null,
        actorOf(actor),
        { ...dto, requestPath },
      ),
      work: async (tx, after) => {
        const r = await tx.urlRewrite.create({
          data: {
            storeId: dto.storeId,
            localeCode: dto.localeCode,
            requestPath,
            targetType: 'CUSTOM',
            targetPath: dto.targetPath.trim(),
            redirectType: dto.redirectType ?? 301,
            isSystem: false,
          },
          select: SELECT,
        });
        after.add(
          new EntityEvent(
            URL_REWRITE_EVENTS.CREATED,
            actorOf(actor),
            'url_rewrite',
            r.id,
            {
              requestPath,
              targetPath: r.targetPath,
              redirectType: r.redirectType,
            },
          ),
        );
        return r;
      },
    });
  }

  /** Only custom redirects can be deleted; system rows follow the catalog. */
  async removeRedirect(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        URL_REWRITE_EVENTS.BEFORE_WRITE,
        'delete',
        id,
        actorOf(actor),
      ),
      work: async (tx, after) => {
        const r = await tx.urlRewrite.findUnique({
          where: { id },
          select: { isSystem: true, requestPath: true },
        });
        if (!r) throw new NotFoundException(`URL rewrite ${id} not found`);
        if (r.isSystem)
          throw new BadRequestException(
            'System URL rewrites follow product and category slugs; change the slug instead',
          );
        await tx.urlRewrite.delete({ where: { id } });
        after.add(
          new EntityEvent(
            URL_REWRITE_EVENTS.DELETED,
            actorOf(actor),
            'url_rewrite',
            id,
            { requestPath: r.requestPath },
          ),
        );
      },
    });
  }

  async rebuildProduct(productId: string): Promise<void> {
    const p = await this.products.urlData(productId);
    let desired: DesiredPath[] = [];
    if (p && !p.deletedAt) {
      const stores = await this.stores.storesOfWebsites(
        p.websites.map((w) => w.websiteId),
        true,
      );
      desired = desiredPaths(
        stores,
        (await this.stores.snapshot()).fallbacks,
        productPath(p.translations),
      );
    }
    await this.sync({ type: 'PRODUCT', id: productId }, desired);
  }

  /** Rebuilds categories (e.g. a moved subtree): each path is built from its ancestors' slugs. */
  async rebuildCategories(ids: readonly string[]): Promise<void> {
    const nodes = await this.categories.withAncestors(ids);
    const { fallbacks } = await this.stores.snapshot(true);
    for (const id of ids) {
      const node = nodes.get(id);
      let desired: DesiredPath[] = [];
      if (node) {
        const ancestry = idsInPath(node.path).map((a) => nodes.get(a));
        if (ancestry.every(Boolean)) {
          const stores = await this.stores.storesOfWebsites(
            node.websiteIds,
            true,
          );
          desired = desiredPaths(
            stores,
            fallbacks,
            categoryPath(ancestry as NonNullable<(typeof ancestry)[number]>[]),
          );
        }
      }
      await this.sync({ type: 'CATEGORY', id }, desired);
    }
  }

  /** Every product and category of a store's website (store created, locales changed, manual rebuild). */
  async rebuildStore(
    storeId: string,
  ): Promise<{ products: number; categories: number }> {
    const store = await this.stores.store(storeId, true);
    if (!store) {
      await this.prisma.urlRewrite.deleteMany({
        where: { storeId, isSystem: true },
      });
      return { products: 0, categories: 0 };
    }
    const productIds = await this.products.idsOnWebsite(store.websiteId);
    for (const id of productIds) await this.rebuildProduct(id);
    const categoryIds = (
      await this.prisma.categoryWebsite.findMany({
        where: { websiteId: store.websiteId },
        select: { categoryId: true },
      })
    ).map((c) => c.categoryId);
    for (let i = 0; i < categoryIds.length; i += 200)
      await this.rebuildCategories(categoryIds.slice(i, i + 200));
    // Rows of targets that left the website entirely.
    await this.prisma.urlRewrite.deleteMany({
      where: {
        storeId,
        isSystem: true,
        OR: [
          { targetType: 'PRODUCT', targetId: { notIn: productIds } },
          { targetType: 'CATEGORY', targetId: { notIn: categoryIds } },
        ],
      },
    });
    return { products: productIds.length, categories: categoryIds.length };
  }

  /** Queues store rebuilds, coalesced per store (see queue/coalesce.ts). */
  async enqueueStoreRebuild(storeIds?: readonly string[]): Promise<string[]> {
    const ids = storeIds?.length
      ? [...storeIds]
      : [...(await this.stores.snapshot(true)).byId.keys()];
    for (const storeId of ids) {
      const generation = await nextGeneration(
        this.redis,
        storeGenerationKey(storeId),
      );
      await this.queue.add(
        JOBS.URL_REWRITES_REBUILD_STORE,
        { storeId, generation },
        {
          delay: COALESCE_DELAY_MS,
          attempts: 3,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }
    return ids;
  }

  /**
   * Reconciles a target's system rows with the paths it should have. Other modules with their own
   * URLs (CMS pages and posts) compute `desired` themselves and call this.
   */
  async sync(
    target: { type: UrlTargetType; id: string },
    desired: DesiredPath[],
  ): Promise<void> {
    await this.bus.write({
      before: new BeforeWriteEvent(
        URL_REWRITE_EVENTS.BEFORE_REBUILD,
        'rebuild',
        target.id,
        SYSTEM_ACTOR,
        target,
      ),
      work: async (tx, after) => {
        const own = await tx.urlRewrite.findMany({
          where: {
            targetType: target.type,
            targetId: target.id,
            isSystem: true,
          },
        });
        const occupants = desired.length
          ? await tx.urlRewrite.findMany({
              where: {
                OR: desired.map((d) => ({
                  storeId: d.storeId,
                  localeCode: d.localeCode,
                  requestPath: d.path,
                })),
                NOT: { targetType: target.type, targetId: target.id },
              },
            })
          : [];
        const plan = planRewrites(target, desired, own, occupants);
        if (plan.delete.length)
          await tx.urlRewrite.deleteMany({
            where: { id: { in: plan.delete } },
          });
        for (const u of plan.update)
          await tx.urlRewrite.update({
            where: { id: u.id },
            data: u.data as Prisma.UrlRewriteUpdateInput,
          });
        if (plan.create.length)
          await tx.urlRewrite.createMany({
            data: plan.create.map((c) => ({
              ...c,
              targetType: target.type,
              targetId: target.id,
              isSystem: true,
            })),
          });
        for (const c of plan.collisions)
          this.logger.warn(
            `URL ${c.path} (${c.localeCode}) is taken in store ${c.storeId}; ${target.type} ${target.id} keeps no URL there`,
          );
        if (
          plan.delete.length +
          plan.update.length +
          plan.create.length +
          plan.collisions.length
        )
          after.add(
            new ProjectionEvent<UrlRewritesRebuiltData>(
              URL_REWRITE_EVENTS.REBUILT,
              {
                targetType: target.type,
                targetId: target.id,
                created: plan.create.length,
                updated: plan.update.length,
                deleted: plan.delete.length,
                collisions: plan.collisions.length,
              },
            ),
          );
      },
    });
  }
}
