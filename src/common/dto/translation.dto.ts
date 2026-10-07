import { BadRequestException } from '@nestjs/common';
import { slugify, SLUG_PATTERN } from '../i18n/slug.js';

/** Validates that each locale appears once in a translation list. */
export function assertUniqueLocales(
  rows: readonly { localeCode: string }[],
  what = 'translations',
): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.localeCode))
      throw new BadRequestException(
        `${what}: locale ${r.localeCode} appears twice`,
      );
    seen.add(r.localeCode);
  }
}

/** Explicit slug (validated) or one derived from the name; fails when neither yields a slug. */
export function resolveSlug(
  name: string,
  slug: string | undefined,
  where: string,
): string {
  const s = slug?.trim() || slugify(name);
  if (!s)
    throw new BadRequestException(
      `${where}: cannot derive a URL key from "${name}"; send a slug`,
    );
  if (!SLUG_PATTERN.test(s))
    throw new BadRequestException(
      `${where}: slug must be lower-case words joined by "-"`,
    );
  return s;
}
