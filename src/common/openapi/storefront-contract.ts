/**
 * The storefront contract (PLAN.md §7.1): the `/api/v1/store` part of the app's OpenAPI document
 * plus every schema it references, with keys sorted so the committed file diffs cleanly.
 * `openapi/storefront.json` is generated from this and reviewed; CI fails on any drift, and the
 * TypeScript client (`packages/storefront-client`) is generated from the committed file.
 */
export const STOREFRONT_PREFIX = '/api/v1/store/';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Json>;
  components?: { schemas?: Record<string, Json> };
}

/** Every `#/components/schemas/X` reference inside a value. */
export function schemaRefs(value: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => schemaRefs(v, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (
        k === '$ref' &&
        typeof v === 'string' &&
        v.startsWith('#/components/schemas/')
      )
        out.add(v.slice('#/components/schemas/'.length));
      else schemaRefs(v, out);
    }
  return out;
}

/** Recursively sorts object keys (arrays keep their order). */
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  return value;
}

export function storefrontContract(doc: OpenApiDoc): Json {
  const paths = Object.fromEntries(
    Object.entries(doc.paths).filter(
      ([p]) =>
        p.startsWith(STOREFRONT_PREFIX) || p === STOREFRONT_PREFIX.slice(0, -1),
    ),
  );
  const all = doc.components?.schemas ?? {};
  const needed = new Set<string>();
  const queue = [...schemaRefs(paths as Json)];
  while (queue.length) {
    const name = queue.pop()!;
    if (needed.has(name) || !all[name]) continue;
    needed.add(name);
    queue.push(...schemaRefs(all[name]));
  }
  return sortKeys({
    openapi: doc.openapi,
    info: {
      title: 'Shop Storefront API',
      version: 'v1',
      description:
        'Public, store-scoped catalog API for storefront themes. Additive changes only within v1. Select the store with X-Store (or the store domain), the locale with Accept-Language or ?locale=, the currency with X-Currency. Account routes take a customer access token (Authorization: Bearer); catalog routes accept it optionally for group prices.',
    },
    paths: paths as Json,
    components: {
      schemas: Object.fromEntries([...needed].map((n) => [n, all[n]])),
      securitySchemes: {
        customer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Customer access token from POST /store/account/login',
        },
      },
    },
  });
}

/** Problems a contract must not have: operations without ids or without a typed 200 response. */
export function contractProblems(contract: Json): string[] {
  const problems: string[] = [];
  const paths = (
    contract as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            responses?: Record<string, { content?: unknown }>;
          }
        >
      >;
    }
  ).paths;
  for (const [path, ops] of Object.entries(paths))
    for (const [method, op] of Object.entries(ops)) {
      if (!op.operationId)
        problems.push(`${method.toUpperCase()} ${path} has no operationId`);
      if (!op.responses?.['200']?.content)
        problems.push(
          `${method.toUpperCase()} ${path} has no typed 200 response`,
        );
    }
  return problems;
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const typeOf = (schema: Obj | undefined) =>
  schema
    ? (schema.$ref ??
      schema.type ??
      (schema.allOf ? JSON.stringify(schema.allOf) : 'object'))
    : undefined;

/**
 * Changes that would break existing storefront clients (PLAN.md §7.1: v1 is additive-only): removed
 * operations, schemas or properties, changed property types, and parameters that became required.
 */
export function breakingChanges(previous: Json, next: Json): string[] {
  const prev = previous as Obj;
  const curr = next as Obj;
  const out: string[] = [];
  for (const [path, ops] of Object.entries<Obj>(prev.paths ?? {}))
    for (const [method, op] of Object.entries<Obj>(ops)) {
      const now = curr.paths?.[path]?.[method];
      if (!now) {
        out.push(`${method.toUpperCase()} ${path} was removed`);
        continue;
      }
      const before = new Map<string, Obj>(
        (op.parameters ?? []).map((p: Obj) => [`${p.in}:${p.name}`, p]),
      );
      for (const p of (now.parameters ?? []) as Obj[])
        if (p.required && !before.get(`${p.in}:${p.name}`)?.required)
          out.push(
            `${method.toUpperCase()} ${path}: parameter ${p.name} is now required`,
          );
      for (const key of before.keys())
        if (
          !(now.parameters ?? []).some((p: Obj) => `${p.in}:${p.name}` === key)
        )
          out.push(
            `${method.toUpperCase()} ${path}: parameter ${key} was removed`,
          );
    }
  for (const [name, schema] of Object.entries<Obj>(
    prev.components?.schemas ?? {},
  )) {
    const now = curr.components?.schemas?.[name] as Obj | undefined;
    if (!now) {
      out.push(`schema ${name} was removed`);
      continue;
    }
    for (const [prop, def] of Object.entries<Obj>(schema.properties ?? {})) {
      const nowProp = now.properties?.[prop] as Obj | undefined;
      if (!nowProp) out.push(`${name}.${prop} was removed`);
      else if (typeOf(nowProp) !== typeOf(def))
        out.push(`${name}.${prop} changed type`);
    }
  }
  return out;
}
