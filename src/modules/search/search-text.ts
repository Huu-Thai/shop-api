/** Text helpers shared by the document builder and the engines. */

/** HTML → plain text (tags and entities removed, whitespace collapsed), capped. */
export function plainText(html: string | null | undefined, max = 5000): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Lower case without diacritics (sort keys, prefix matching). */
export function fold(text: string): string {
  return text
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Search terms: folded words of letters/digits (keeps any script), max 10. */
export function terms(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 10);
}
