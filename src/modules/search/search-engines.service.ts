import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import type { Queue } from 'bullmq';
import { SYSTEM_ACTOR } from '../../common/auth/principal.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import {
  BeforeWriteEvent,
  EntityEvent,
} from '../../common/events/entity.events.js';
import { TransactionalEventBus } from '../../common/events/transactional-event-bus.js';
import { PrismaService } from '../../database/prisma.service.js';
import { JOBS } from '../../queue/jobs.js';
import { QUEUES } from '../../queue/queue.constants.js';
import { StoresQuery } from '../stores/stores.query.js';
import { SearchProviders } from './providers/registry.js';
import {
  type EngineRef,
  type EngineSettings,
  SearchSettingsQuery,
} from './search-settings.query.js';
import {
  SEARCH_EVENTS,
  type SearchSettingsEventData,
} from './search.events.js';
import {
  indexName,
  type IndexTarget,
  type SearchDocumentBody,
} from './search.types.js';

const COPY_BATCH = 500;

export interface DropIndexesJob {
  provider: EngineRef['provider'];
  /** Sealed connection of the old engine. */
  connection: string | null;
  targets: IndexTarget[];
}

/**
 * Keeps external engines in step with `search_documents` and runs zero-downtime switches:
 * build the pending generation from Postgres while writes go to both engines, catch up on
 * documents changed during the build, flip the active generation atomically, catch up once more,
 * then drop the old indexes later. Reads stay on the old engine until the flip.
 */
@Injectable()
export class SearchEngines {
  private readonly logger = new Logger(SearchEngines.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
    private readonly stores: StoresQuery,
    private readonly settings: SearchSettingsQuery,
    private readonly providers: SearchProviders,
    private readonly secrets: SecretsService,
    @InjectQueue(QUEUES.SEARCH_INDEX) private readonly queue: Queue,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Index targets of a website's stores × locales for an engine generation. */
  async targets(s: EngineSettings, generation: number): Promise<IndexTarget[]> {
    const snap = await this.stores.snapshot(true);
    return [...snap.byId.values()]
      .filter((st) => st.websiteId === s.websiteId)
      .flatMap((st) =>
        st.localeCodes.map((localeCode) => ({
          storeId: st.id,
          storeCode: st.code,
          localeCode,
          index: indexName(s.prefix, generation, st.code, localeCode),
        })),
      );
  }

  private async docs(
    storeId: string,
    localeCode: string,
    ids: string[],
  ): Promise<SearchDocumentBody[]> {
    const rows = await this.prisma.searchDocument.findMany({
      where: {
        storeId,
        localeCode,
        entityType: 'PRODUCT',
        entityId: { in: ids },
      },
      select: { document: true },
    });
    return rows.map((r) => r.document as unknown as SearchDocumentBody);
  }

  /** After-listener work: push changed documents to the active and (while building) pending engine. */
  async push(
    storeId: string,
    localeCode: string,
    upserted: string[],
    removed: string[],
  ): Promise<void> {
    const store = await this.stores.store(storeId, true);
    if (!store) return;
    const s = await this.settings.effective(store.websiteId, true);
    const engines = [s.active, ...(s.pending ? [s.pending] : [])].filter(
      (e) => e.provider !== 'POSTGRES',
    );
    if (!engines.length) return;
    const docs = await this.docs(storeId, localeCode, upserted);
    for (const e of engines) {
      const target = {
        storeId,
        storeCode: store.code,
        localeCode,
        index: indexName(s.prefix, e.generation, store.code, localeCode),
      };
      const provider = this.providers.for(e);
      await provider.index(target, docs);
      await provider.remove(target, removed);
    }
  }

  /** Copies documents (all, or changed since a time) of every target into an engine. */
  private async copy(
    engine: EngineRef,
    targets: IndexTarget[],
    since?: Date,
  ): Promise<number> {
    const provider = this.providers.for(engine);
    let copied = 0;
    for (const t of targets) {
      let cursor: string | undefined;
      for (;;) {
        const rows = await this.prisma.searchDocument.findMany({
          where: {
            storeId: t.storeId,
            localeCode: t.localeCode,
            entityType: 'PRODUCT',
            ...(since ? { updatedAt: { gte: since } } : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: COPY_BATCH,
          select: { id: true, document: true },
        });
        if (!rows.length) break;
        await provider.index(
          t,
          rows.map((r) => r.document as unknown as SearchDocumentBody),
          true,
        );
        copied += rows.length;
        cursor = rows[rows.length - 1].id;
      }
    }
    return copied;
  }

  /** The switch job. Skips itself when a newer switch superseded this generation. */
  async switch(
    websiteId: string,
    generation: number,
  ): Promise<{ copied: number } | { skipped: string }> {
    const s = await this.settings.effective(websiteId, true);
    if (!s.pending || s.pending.generation !== generation)
      return { skipped: `generation ${generation} is not pending` };
    const pending = s.pending;
    const started = new Date();
    try {
      const targets = await this.targets(s, generation);
      if (pending.provider !== 'POSTGRES') {
        const provider = this.providers.for(pending);
        await provider.health();
        for (const t of targets)
          await provider.createIndex(t, {
            localeCode: t.localeCode,
            synonyms: s.synonyms,
            stopwords: s.stopwords,
          });
      }
      let copied =
        pending.provider === 'POSTGRES' ? 0 : await this.copy(pending, targets);
      const caughtUp = new Date();
      if (pending.provider !== 'POSTGRES')
        copied += await this.copy(pending, targets, started);
      const old = await this.flip(websiteId, generation);
      if (!old)
        return {
          skipped: `generation ${generation} was superseded during the build`,
        };
      if (pending.provider !== 'POSTGRES')
        copied += await this.copy(pending, targets, caughtUp);
      if (old.provider !== 'POSTGRES') {
        const job: DropIndexesJob = {
          provider: old.provider,
          connection: old.connection ?? null,
          targets: await this.targets(s, old.generation),
        };
        await this.queue.add(JOBS.SEARCH_DROP_INDEXES, job, {
          delay: this.config.get('search', { infer: true }).dropDelayMs,
          attempts: 3,
          removeOnComplete: 50,
          removeOnFail: 50,
        });
      }
      this.logger.log(
        `Search: website ${websiteId} switched to ${pending.provider} (generation ${generation}, ${copied} documents copied)`,
      );
      return { copied };
    } catch (e) {
      const message = (e as Error).message.slice(0, 1000);
      this.logger.error(
        `Search switch of website ${websiteId} to ${pending.provider} failed: ${message}`,
      );
      await this.bus.write({
        before: new BeforeWriteEvent(
          SEARCH_EVENTS.SETTINGS_BEFORE_WRITE,
          'switch-failed',
          websiteId,
          SYSTEM_ACTOR,
        ),
        work: async (tx, after) => {
          await tx.searchSettings.updateMany({
            where: { websiteId, pendingGeneration: generation },
            data: { status: 'FAILED', lastError: message },
          });
          after.add(
            new EntityEvent<SearchSettingsEventData>(
              SEARCH_EVENTS.SWITCH_FAILED,
              SYSTEM_ACTOR,
              'search_settings',
              websiteId,
              { provider: pending.provider, error: message },
              { websiteId },
            ),
          );
        },
      });
      throw e;
    }
  }

  /** Atomically makes the pending engine active; returns the previous one (sealed connection). */
  private async flip(
    websiteId: string,
    generation: number,
  ): Promise<
    | {
        provider: EngineRef['provider'];
        connection: string | null;
        generation: number;
      }
    | undefined
  > {
    return this.bus.write({
      before: new BeforeWriteEvent(
        SEARCH_EVENTS.SETTINGS_BEFORE_WRITE,
        'flip',
        websiteId,
        SYSTEM_ACTOR,
      ),
      work: async (tx, after) => {
        const row = await tx.searchSettings.findUnique({
          where: { websiteId },
        });
        if (
          !row ||
          row.pendingGeneration !== generation ||
          !row.pendingProvider
        )
          return undefined;
        await tx.searchSettings.update({
          where: { websiteId },
          data: {
            provider: row.pendingProvider,
            connection: row.pendingConnection,
            activeGeneration: generation,
            pendingProvider: null,
            pendingConnection: null,
            pendingGeneration: null,
            status: 'READY',
            lastError: null,
            lastBuiltAt: new Date(),
          },
        });
        after.add(
          new EntityEvent<SearchSettingsEventData>(
            SEARCH_EVENTS.SWITCHED,
            SYSTEM_ACTOR,
            'search_settings',
            websiteId,
            { from: row.provider, to: row.pendingProvider, generation },
            { websiteId },
          ),
        );
        return {
          provider: row.provider,
          connection: row.connection,
          generation: row.activeGeneration,
        };
      },
    });
  }

  /** Delayed cleanup of the previous generation's indexes. */
  async drop(job: DropIndexesJob): Promise<number> {
    const provider = this.providers.for({
      provider: job.provider,
      connection: job.connection
        ? this.secrets.open(job.connection)
        : undefined,
    });
    for (const t of job.targets) await provider.dropIndex(t);
    return job.targets.length;
  }
}
