/** `{{block id="footer-links"}}` (quotes may arrive HTML-escaped from the sanitizer). */
const TOKEN =
  /\{\{\s*block\s+id=(?:"|'|&quot;|&#39;|&#x27;)([a-z0-9]+(?:[-_][a-z0-9]+)*)(?:"|'|&quot;|&#39;|&#x27;)\s*\}\}/g;

export const MAX_BLOCK_DEPTH = 3;

/** Block identifiers referenced by a piece of content, in order of appearance (unique). */
export function blockIdentifiers(html: string): string[] {
  return [...new Set([...html.matchAll(TOKEN)].map((m) => m[1]))];
}

/**
 * Replaces block tokens with the blocks' content, recursively up to `maxDepth` levels. Unknown or
 * hidden blocks, cycles (a block including itself) and deeper levels render as nothing.
 * `load` returns the content of the identifiers it can show; it is called once per level.
 */
export async function renderBlocks(
  html: string,
  load: (identifiers: string[]) => Promise<Map<string, string>>,
  maxDepth = MAX_BLOCK_DEPTH,
): Promise<string> {
  const contents = new Map<string, string | null>();
  let frontier = blockIdentifiers(html);
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const missing = frontier.filter((id) => !contents.has(id));
    if (!missing.length) break;
    const loaded = await load(missing);
    for (const id of missing) contents.set(id, loaded.get(id) ?? null);
    frontier = missing.flatMap((id) =>
      blockIdentifiers(contents.get(id) ?? ''),
    );
  }
  const render = (text: string, stack: readonly string[]): string =>
    text.replace(TOKEN, (_, id: string) => {
      if (stack.includes(id) || stack.length >= maxDepth) return '';
      const c = contents.get(id);
      return c == null ? '' : render(c, [...stack, id]);
    });
  return render(html, []);
}
