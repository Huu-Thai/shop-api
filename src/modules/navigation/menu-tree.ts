/** Orders a flat item list depth-first (parents before children, siblings by position). */
export function treeOrder<
  T extends { id: string; parentId: string | null; position: number },
>(items: readonly T[]): T[] {
  const children = new Map<string | null, T[]>();
  for (const i of items) {
    const list = children.get(i.parentId) ?? [];
    list.push(i);
    children.set(i.parentId, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const out: T[] = [];
  const walk = (parent: string | null) => {
    for (const c of children.get(parent) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(null);
  return out;
}

/** Depth of an item (1 = top level) from its parent chain. */
export function depthOf(
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): number {
  let depth = 1;
  for (let p = parentId; p; p = parents.get(p) ?? null) depth++;
  return depth;
}

/** Would moving `id` under `parentId` create a cycle? */
export function createsCycle(
  id: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  for (let p = parentId; p; p = parents.get(p) ?? null)
    if (p === id) return true;
  return false;
}

export interface TreeNode<T> {
  item: T;
  children: TreeNode<T>[];
}

/** Builds the visible tree: items that `keep` rejects are dropped with their subtrees. */
export function buildVisibleTree<
  T extends { id: string; parentId: string | null; position: number },
>(items: readonly T[], keep: (item: T) => boolean): TreeNode<T>[] {
  const byParent = new Map<string | null, T[]>();
  for (const i of treeOrder(items)) {
    const list = byParent.get(i.parentId) ?? [];
    list.push(i);
    byParent.set(i.parentId, list);
  }
  const build = (parent: string | null): TreeNode<T>[] =>
    (byParent.get(parent) ?? [])
      .filter(keep)
      .map((item) => ({ item, children: build(item.id) }));
  return build(null);
}
