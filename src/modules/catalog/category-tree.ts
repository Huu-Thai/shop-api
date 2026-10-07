/** Pure helpers for the materialised-path category tree. */

export const pathOf = (parentPath: string | null, id: string) =>
  parentPath ? `${parentPath}/${id}` : id;

/** Ids from root to the node itself. */
export const idsInPath = (path: string) => path.split('/');

export const isInSubtree = (path: string, rootPath: string) =>
  path === rootPath || path.startsWith(`${rootPath}/`);

/** Builds a nested tree from flat rows (children ordered by position, then the given order). */
export function buildTree<
  T extends { id: string; parentId: string | null; position: number },
>(rows: readonly T[]): (T & { children: (T & { children: unknown[] })[] })[] {
  type Node = T & { children: Node[] };
  const nodes = new Map<string, Node>(
    rows.map((r) => [r.id, { ...r, children: [] }]),
  );
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else if (!n.parentId) roots.push(n);
    // Nodes whose parent was filtered out are dropped with it (e.g. inactive parent on the storefront).
  }
  const sort = (list: Node[]) => {
    list.sort((a, b) => a.position - b.position);
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
