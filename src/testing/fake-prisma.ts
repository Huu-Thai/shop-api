import { type Mock, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...args: any[]) => any;
type Fn = Mock<AnyFn>;
export type FakeModel = Record<string, Fn>;
export type FakePrisma = Record<string, FakeModel> & {
  $queryRaw: Fn;
  $executeRaw: Fn;
};

/**
 * A Prisma client / transaction double: every `model.method` is a lazily created `vi.fn()` that
 * resolves to undefined until a test configures it (`prisma.product.findUnique.mockResolvedValue`).
 * Writes default to echoing their `data`, counts to 0 and lists to [].
 */
export function fakePrisma(): FakePrisma {
  const models = new Map<string, FakeModel>();
  const raw = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  const defaults: Record<string, (args?: { data?: unknown }) => unknown> = {
    findMany: () => [],
    count: () => 0,
    deleteMany: () => ({ count: 0 }),
    updateMany: () => ({ count: 0 }),
    createMany: () => ({ count: 0 }),
    create: (a) => ({ id: 'new-id', ...(a?.data as object) }),
    update: (a) => ({ ...(a?.data as object) }),
    upsert: () => ({ id: 'upserted-id' }),
  };
  return new Proxy(raw as FakePrisma, {
    get(target, prop: string) {
      if (prop in target) return target[prop as '$queryRaw'];
      if (prop === 'then') return undefined;
      if (!models.has(prop))
        models.set(
          prop,
          new Proxy({} as FakeModel, {
            get(m, method: string) {
              m[method] ??= vi.fn(async (args?: { data?: unknown }) =>
                defaults[method]?.(args),
              );
              return m[method];
            },
          }),
        );
      return models.get(prop);
    },
  });
}
