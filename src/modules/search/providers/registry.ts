import { Injectable } from '@nestjs/common';
import type { EngineRef } from '../search-settings.query.js';
import type { SearchProvider } from '../search.types.js';
import { ElasticLikeProvider } from './elastic.provider.js';
import { MeiliProvider } from './meili.provider.js';
import { PostgresSearchProvider } from './postgres.provider.js';

/** Provider instances per engine reference (external clients are cheap; cached by kind + URL + key). */
@Injectable()
export class SearchProviders {
  private readonly cache = new Map<string, SearchProvider>();

  constructor(readonly postgres: PostgresSearchProvider) {}

  for(ref: Pick<EngineRef, 'provider' | 'connection'>): SearchProvider {
    if (ref.provider === 'POSTGRES') return this.postgres;
    if (!ref.connection)
      throw new Error(
        `${ref.provider} has no usable connection (is APP_ENCRYPTION_KEY set?)`,
      );
    const key = `${ref.provider}|${ref.connection.url}|${ref.connection.apiKey ?? ''}|${ref.connection.username ?? ''}`;
    let p = this.cache.get(key);
    if (!p) {
      p =
        ref.provider === 'MEILISEARCH'
          ? new MeiliProvider(ref.connection)
          : new ElasticLikeProvider(ref.provider, ref.connection);
      this.cache.set(key, p);
    }
    return p;
  }
}
