import {
  localeChain,
  pickTranslation,
} from '../../common/i18n/locale-chain.js';

export interface StoreLocales {
  id: string;
  websiteId: string;
  defaultLocaleCode: string;
  localeCodes: string[];
}

export interface DesiredPath {
  storeId: string;
  localeCode: string;
  path: string;
}

export interface ExistingRewrite {
  id: string;
  storeId: string;
  localeCode: string;
  requestPath: string;
  targetType: string;
  targetId: string | null;
  redirectType: number | null;
  isSystem: boolean;
}

/** Normalises a storefront path for lookups: no slashes at the ends, no query, lower case, max 512. */
export function normalizePath(raw: string): string {
  let p = raw.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw path when it isn't valid percent-encoding
  }
  return p
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase()
    .slice(0, 512);
}

/** One path per store × enabled locale, from the slug chosen along that locale's fallback chain. */
export function desiredPaths(
  stores: readonly StoreLocales[],
  fallbacks: ReadonlyMap<string, string | null>,
  pathFor: (chain: string[]) => string | undefined,
): DesiredPath[] {
  const out: DesiredPath[] = [];
  for (const s of stores)
    for (const localeCode of s.localeCodes) {
      const path = pathFor(
        localeChain(localeCode, fallbacks, s.defaultLocaleCode),
      );
      if (path) out.push({ storeId: s.id, localeCode, path });
    }
  return out;
}

/** Product URL: its slug. */
export const productPath =
  (translations: readonly { localeCode: string; slug: string }[]) =>
  (chain: string[]) =>
    pickTranslation(translations, chain)?.slug;

/** Category URL: the slugs from the root down; undefined if any level lacks a translation. */
export const categoryPath =
  (
    ancestry: readonly {
      translations: readonly { localeCode: string; slug: string }[];
    }[],
  ) =>
  (chain: string[]): string | undefined => {
    const parts: string[] = [];
    for (const node of ancestry) {
      const t = pickTranslation(node.translations, chain);
      if (!t) return undefined;
      parts.push(t.slug);
    }
    return parts.join('/');
  };

export type RewritePlan = {
  /** Rows to delete (system rows of the target that are no longer wanted). */
  delete: string[];
  /** Existing rows to update. */
  update: {
    id: string;
    data: {
      targetType?: string;
      targetId?: string;
      redirectType: number | null;
    };
  }[];
  create: {
    storeId: string;
    localeCode: string;
    requestPath: string;
    redirectType: number | null;
  }[];
  /** Desired paths taken by another target's canonical URL or a custom rewrite (left untouched). */
  collisions: DesiredPath[];
};

const key = (storeId: string, localeCode: string, path?: string) =>
  `${storeId}|${localeCode}|${path ?? ''}`;

/**
 * Reconciles a target's system rewrites with its desired paths:
 * - the desired path becomes (or stays) canonical; a former canonical path becomes a 301 to it;
 * - a redirect of another target sitting on the desired path is taken over;
 * - store/locale pairs no longer wanted lose all the target's system rows.
 * `existingOwn` = the target's own system rows; `occupants` = rows of others on the desired paths.
 */
export function planRewrites(
  target: { type: string; id: string },
  desired: readonly DesiredPath[],
  existingOwn: readonly ExistingRewrite[],
  occupants: readonly ExistingRewrite[],
): RewritePlan {
  const plan: RewritePlan = {
    delete: [],
    update: [],
    create: [],
    collisions: [],
  };
  const wanted = new Map(desired.map((d) => [key(d.storeId, d.localeCode), d]));
  const own = new Map(
    existingOwn.map((r) => [key(r.storeId, r.localeCode, r.requestPath), r]),
  );
  const others = new Map(
    occupants.map((r) => [key(r.storeId, r.localeCode, r.requestPath), r]),
  );

  for (const r of existingOwn) {
    const d = wanted.get(key(r.storeId, r.localeCode));
    if (!d) plan.delete.push(r.id);
    else if (r.requestPath !== d.path && r.redirectType === null)
      plan.update.push({ id: r.id, data: { redirectType: 301 } });
  }
  for (const d of desired) {
    const k = key(d.storeId, d.localeCode, d.path);
    const mine = own.get(k);
    if (mine) {
      if (mine.redirectType !== null)
        plan.update.push({ id: mine.id, data: { redirectType: null } });
      continue;
    }
    const other = others.get(k);
    if (!other)
      plan.create.push({
        storeId: d.storeId,
        localeCode: d.localeCode,
        requestPath: d.path,
        redirectType: null,
      });
    else if (other.isSystem && other.redirectType !== null)
      plan.update.push({
        id: other.id,
        data: {
          targetType: target.type,
          targetId: target.id,
          redirectType: null,
        },
      });
    else plan.collisions.push(d);
  }
  return plan;
}
