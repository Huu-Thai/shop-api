import { Transform } from 'class-transformer';

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Page slugs may have segments (`help/shipping`); post slugs may not. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;
export const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const IDENTIFIER_MESSAGE =
  'must be lower-case letters and digits joined by "-" or "_"';
export const REGION_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export const Trim = () => Transform(trim);
