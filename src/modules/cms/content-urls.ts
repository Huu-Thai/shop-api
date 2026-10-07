import {
  localeChain,
  pickTranslation,
} from '../../common/i18n/locale-chain.js';
import type { DesiredPath, StoreLocales } from '../url-rewrites/url-paths.js';

export interface SluggedContent {
  id: string;
  storeId: string | null;
  translations: readonly { localeCode: string; slug: string }[];
}

/** URL prefixes: pages live at `/<slug>`, posts at `/blog/<slug>`. */
export const PAGE_PREFIX = '';
export const POST_PREFIX = 'blog/';

/**
 * Paths of a page or post per store × locale. A global item (`storeId` null) is shown in every
 * store, except where a store-specific item claims the same slug (`shadows`): the store's own
 * content wins there.
 */
export function contentPaths(
  item: SluggedContent,
  stores: readonly StoreLocales[],
  fallbacks: ReadonlyMap<string, string | null>,
  prefix: string,
  shadows: readonly SluggedContent[] = [],
): DesiredPath[] {
  const out: DesiredPath[] = [];
  const scope = item.storeId
    ? stores.filter((s) => s.id === item.storeId)
    : stores;
  for (const s of scope)
    for (const localeCode of s.localeCodes) {
      const chain = localeChain(localeCode, fallbacks, s.defaultLocaleCode);
      const t = pickTranslation(item.translations, chain);
      if (!t) continue;
      const shadowed =
        !item.storeId &&
        shadows.some(
          (o) =>
            o.storeId === s.id &&
            o.id !== item.id &&
            pickTranslation(o.translations, chain)?.slug === t.slug,
        );
      if (!shadowed)
        out.push({ storeId: s.id, localeCode, path: `${prefix}${t.slug}` });
    }
  return out;
}
