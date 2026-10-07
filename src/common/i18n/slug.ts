/** Letters NFD can't split into base + accent. */
const SPECIAL: Record<string, string> = {
  đ: 'd',
  Đ: 'd',
  ß: 'ss',
  æ: 'ae',
  ø: 'o',
  œ: 'oe',
  ł: 'l',
  þ: 'th',
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** URL-safe ASCII slug: `Áo thun Đỏ – Size M` → `ao-thun-do-size-m`. Empty when nothing is left. */
export function slugify(input: string, maxLength = 200): string {
  return input
    .replace(/[đĐßæøœłþ]/g, (c) => SPECIAL[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
