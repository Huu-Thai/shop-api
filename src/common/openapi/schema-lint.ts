type Schema = Record<string, unknown>;

/**
 * Properties documented as a bare `object` (no properties, map type or `$ref`). Nest's Swagger
 * plugin emits these for union types like `Date | null` without an explicit `type`, and generated
 * clients then type them as `Record<string, never>`.
 */
export function untypedProperties(spec: {
  components?: { schemas?: Record<string, Schema> };
}): string[] {
  const out: string[] = [];
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, p] of Object.entries(props))
      if (
        p.type === 'object' &&
        !p.properties &&
        !p.additionalProperties &&
        !p.allOf &&
        !p.oneOf &&
        !p.anyOf &&
        !p.$ref
      )
        out.push(`${name}.${key}`);
  }
  return out;
}
