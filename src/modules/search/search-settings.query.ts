import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VersionedSnapshot } from '../../common/cache/versioned-snapshot.js';
import { SecretsService } from '../../common/crypto/secrets.service.js';
import type {
  SearchBuildStatus,
  SearchProviderKind,
} from '../../database/generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { REDIS_CLIENT } from '../../redis/redis.module.js';
import type { SearchConnection } from './search.types.js';

export const SEARCH_VERSION_KEY = 'search:config-version';

export interface EngineRef {
  provider: SearchProviderKind;
  connection?: SearchConnection;
  generation: number;
}

export interface EngineSettings {
  websiteId: string;
  active: EngineRef;
  /** The engine being built during a switch (writes go to both). */
  pending?: EngineRef;
  prefix: string;
  synonyms: string[][];
  stopwords: string[];
  status: SearchBuildStatus;
  buildStartedAt: Date | null;
}

const DEFAULT = (websiteId: string): EngineSettings => ({
  websiteId,
  active: { provider: 'POSTGRES', generation: 0 },
  prefix: 'shop',
  synonyms: [],
  stopwords: [],
  status: 'READY',
  buildStartedAt: null,
});

/** Effective search engine per website (Postgres when unset), with decrypted connections. */
@Injectable()
export class SearchSettingsQuery {
  private readonly logger = new Logger(SearchSettingsQuery.name);
  private readonly snapshot: VersionedSnapshot<Map<string, EngineSettings>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.snapshot = new VersionedSnapshot(redis, SEARCH_VERSION_KEY, () =>
      this.load(),
    );
  }

  async effective(websiteId: string, fresh = false): Promise<EngineSettings> {
    return (
      (await this.snapshot.get(fresh)).get(websiteId) ?? DEFAULT(websiteId)
    );
  }

  invalidate(): Promise<void> {
    return this.snapshot.invalidate();
  }

  private open(sealed: string | null): SearchConnection | undefined {
    if (!sealed) return undefined;
    try {
      return this.secrets.open<SearchConnection>(sealed);
    } catch (e) {
      this.logger.error(
        `Cannot open a search connection: ${(e as Error).message}`,
      );
      return undefined;
    }
  }

  private async load(): Promise<Map<string, EngineSettings>> {
    const rows = await this.prisma.searchSettings.findMany();
    return new Map(
      rows.map((r) => [
        r.websiteId,
        {
          websiteId: r.websiteId,
          active: {
            provider: r.provider,
            connection: this.open(r.connection),
            generation: r.activeGeneration,
          },
          pending:
            r.pendingProvider && r.pendingGeneration !== null
              ? {
                  provider: r.pendingProvider,
                  connection: this.open(r.pendingConnection),
                  generation: r.pendingGeneration,
                }
              : undefined,
          prefix: r.indexPrefix,
          synonyms: r.synonyms as string[][],
          stopwords: r.stopwords as string[],
          status: r.status,
          buildStartedAt: r.buildStartedAt,
        },
      ]),
    );
  }
}
