/**
 * Translation fallback (PLAN.md §0 #7): requested locale → its `fallback_code` chain → the store's
 * default locale. Cycles are cut; every code appears once.
 */
export function localeChain(
  requested: string,
  fallbacks: ReadonlyMap<string, string | null>,
  storeDefault?: string,
): string[] {
  const chain: string[] = [];
  let code: string | null | undefined = requested;
  while (code && !chain.includes(code)) {
    chain.push(code);
    code = fallbacks.get(code) ?? null;
  }
  if (storeDefault && !chain.includes(storeDefault)) chain.push(storeDefault);
  return chain;
}

/** First translation along the chain, or undefined. */
export function pickTranslation<T extends { localeCode: string }>(
  rows: readonly T[],
  chain: readonly string[],
): T | undefined {
  for (const code of chain) {
    const hit = rows.find((r) => r.localeCode === code);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Picks the best supported locale for an `Accept-Language` header (RFC 9110 q-values; exact
 * match first, then same language). Returns undefined when nothing matches.
 */
export function negotiateLocale(
  header: string | undefined,
  supported: readonly string[],
): string | undefined {
  if (!header) return undefined;
  const wanted = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((w) => w.tag && w.tag !== '*' && w.q > 0 && !Number.isNaN(w.q))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const lower = supported.map((s) => s.toLowerCase());
  for (const { tag } of wanted) {
    const exact = lower.indexOf(tag.toLowerCase());
    if (exact >= 0) return supported[exact];
    const lang = tag.split('-')[0].toLowerCase();
    const sameLang = lower.findIndex((s) => s.split('-')[0] === lang);
    if (sameLang >= 0) return supported[sameLang];
  }
  return undefined;
}
