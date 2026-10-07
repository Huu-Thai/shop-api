import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { actorOf, type Principal } from '../../common/auth/principal.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS, type SearchWebsiteJob } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StoresQuery } from '../stores/stores.query.js';
import type {
  SearchStatusDto,
  UpdateSearchSettingsDto,
} from './dto/search-admin.dto.js';
import { SearchProviders } from './providers/registry.js';
import {
  SEARCH_EVENTS,
  type SearchSettingsEventData,
} from './search.events.js';
import type { SearchConnection } from './search.types.js';

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Admin: which engine a website searches with, and switching engines without downtime. */
@Injectable()
export class SearchSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly secrets: SecretsService,
    private readonly providers: SearchProviders,
    private readonly stores: StoresQuery,
    @InjectQueue(QUEUES.SEARCH_INDEX)
    private readonly queue: Queue<SearchWebsiteJob>,
  ) {}

  async status(websiteId: string): Promise<SearchStatusDto> {
    if (!(await this.prisma.website.count({ where: { id: websiteId } })))
      throw new NotFoundException(`Website ${websiteId} not found`);
    const row = await this.prisma.searchSettings.findUnique({
      where: { websiteId },
    });
    const url = (sealed: string | null | undefined) => {
      if (!sealed) return null;
      try {
        return this.secrets.open<SearchConnection>(sealed).url;
      } catch {
        return null;
      }
    };
    const stores = await this.stores.storesOfWebsites([websiteId], true);
    const counts = await this.prisma.searchDocument.groupBy({
      by: ['storeId', 'localeCode'],
      where: { storeId: { in: stores.map((s) => s.id) } },
      _count: { _all: true },
    });
    return {
      websiteId,
      active: {
        provider: row?.provider ?? 'POSTGRES',
        url: url(row?.connection),
        generation: row?.activeGeneration ?? 0,
      },
      pending: row?.pendingProvider
        ? {
            provider: row.pendingProvider,
            url: url(row.pendingConnection),
            generation: row.pendingGeneration ?? 0,
          }
        : null,
      status: row?.status ?? 'READY',
      lastError: row?.lastError ?? null,
      lastBuiltAt: row?.lastBuiltAt ?? null,
      indexPrefix: row?.indexPrefix ?? 'shop',
      synonyms: (row?.synonyms as string[][]) ?? [],
      stopwords: (row?.stopwords as string[]) ?? [],
      documents: counts.map((c) => ({
        storeCode: stores.find((s) => s.id === c.storeId)?.code ?? c.storeId,
        localeCode: c.localeCode,
        documents: c._count._all,
      })),
    };
  }

  /**
   * Saves the engine settings. A different engine, connection, prefix or analysis settings starts a
   * switch: the new generation is built in the background while the current engine keeps serving.
   */
  async update(
    websiteId: string,
    dto: UpdateSearchSettingsDto,
    actor: Principal,
  ): Promise<SearchStatusDto> {
    if (!(await this.prisma.website.count({ where: { id: websiteId } })))
      throw new NotFoundException(`Website ${websiteId} not found`);
    const row = await this.prisma.searchSettings.findUnique({
      where: { websiteId },
    });
    const current = {
      provider: row?.provider ?? 'POSTGRES',
      connection: row?.connection
        ? this.secrets.open<SearchConnection>(row.connection)
        : undefined,
    };
    let connection: SearchConnection | undefined;
    if (dto.provider !== 'POSTGRES') {
      connection =
        dto.connection ??
        (dto.provider === current.provider ? current.connection : undefined);
      if (!connection)
        throw new BadRequestException(
          `connection is required for ${dto.provider}`,
        );
      try {
        await this.providers
          .for({ provider: dto.provider, connection })
          .health();
      } catch (e) {
        throw new BadRequestException(
          `Cannot reach ${dto.provider}: ${(e as Error).message}`,
        );
      }
    }
    const prefix = dto.indexPrefix ?? row?.indexPrefix ?? 'shop';
    const synonyms = (dto.synonyms ?? (row?.synonyms as string[][]) ?? [])
      .map((g) => g.map((w) => w.trim().toLowerCase()).filter(Boolean))
      .filter((g) => g.length > 1);
    const stopwords = (dto.stopwords ?? (row?.stopwords as string[]) ?? [])
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const needsBuild =
      dto.provider !== current.provider ||
      !same(connection, current.connection) ||
      (dto.provider !== 'POSTGRES' &&
        (prefix !== (row?.indexPrefix ?? 'shop') ||
          !same(synonyms, row?.synonyms ?? []) ||
          !same(stopwords, row?.stopwords ?? [])));
    const sealed = connection ? this.secrets.seal(connection) : null;

    const generation = await this.bus.write({
      before: new BeforeWriteEvent(
        SEARCH_EVENTS.SETTINGS_BEFORE_WRITE,
        'update',
        websiteId,
        actorOf(actor),
        { provider: dto.provider },
      ),
      work: async (tx, after) => {
        const base = { indexPrefix: prefix, synonyms, stopwords };
        const next =
          Math.max(row?.activeGeneration ?? 0, row?.pendingGeneration ?? 0) + 1;
        const pending = needsBuild
          ? {
              pendingProvider: dto.provider,
              pendingConnection: sealed,
              pendingGeneration: next,
              status: 'BUILDING' as const,
              lastError: null,
              buildStartedAt: new Date(),
            }
          : {};
        await tx.searchSettings.upsert({
          where: { websiteId },
          create: { websiteId, ...base, ...pending },
          update: { ...base, ...pending },
        });
        after.add(
          new EntityEvent<SearchSettingsEventData>(
            needsBuild
              ? SEARCH_EVENTS.SWITCH_STARTED
              : SEARCH_EVENTS.SETTINGS_UPDATED,
            actorOf(actor),
            'search_settings',
            websiteId,
            {
              provider: dto.provider,
              url: connection?.url ?? null,
              indexPrefix: prefix,
              synonyms: synonyms.length,
              stopwords: stopwords.length,
            },
            { websiteId },
          ),
        );
        return needsBuild ? next : undefined;
      },
    });
    if (generation !== undefined)
      await this.queue.add(
        JOBS.SEARCH_SWITCH,
        { websiteId, generation },
        { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
      );
    return this.status(websiteId);
  }

  /** Rebuilds a website's documents (and its external engine through the documents-changed events). */
  async reindex(websiteId: string): Promise<void> {
    if (!(await this.prisma.website.count({ where: { id: websiteId } })))
      throw new NotFoundException(`Website ${websiteId} not found`);
    await this.queue.add(
      JOBS.SEARCH_REINDEX_WEBSITE,
      { websiteId },
      { attempts: 3, removeOnComplete: 50, removeOnFail: 50 },
    );
  }
}
