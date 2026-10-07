import { HttpException } from '@nestjs/common';

/** A failed call as one line of text (validation messages joined), e.g. for import row errors. */
export function errorText(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse() as string | { message?: string | string[] };
    const m = typeof r === 'string' ? r : r.message;
    return Array.isArray(m) ? m.join('; ') : (m ?? e.message);
  }
  return (e as Error).message;
}
