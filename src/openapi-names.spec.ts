import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Swagger names schemas after DTO classes; two exported classes with the same name in different
 * modules silently overwrite each other in the OpenAPI document (and in generated clients).
 */
function dtoFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return dtoFiles(p);
    return f.endsWith('.dto.ts') ? [p] : [];
  });
}

describe('OpenAPI schema names', () => {
  it('every exported DTO class name is unique', () => {
    const root = new URL('.', import.meta.url).pathname;
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const file of dtoFiles(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /^export class (\w+)/gm,
      )) {
        const prev = seen.get(m[1]);
        if (prev)
          dupes.push(
            `${m[1]}: ${relative(root, prev)} and ${relative(root, file)}`,
          );
        else seen.set(m[1], file);
      }
    }
    expect(dupes).toEqual([]);
  });
});
