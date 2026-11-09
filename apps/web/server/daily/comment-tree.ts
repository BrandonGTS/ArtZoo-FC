/** Read-only projection: removed or unreachable ancestry never becomes a new root. */
export type CommentNode = { id: string; parentId: string | null; removedAt: Date | null };
export function visibleCommentIds(rows: readonly CommentNode[]): Set<string> {
  const children = new Map<string | null, CommentNode[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row);
    children.set(row.parentId, siblings);
  }
  const visible = new Set<string>(),
    stack = [...(children.get(null) ?? [])];
  while (stack.length) {
    const row = stack.pop()!;
    if (row.removedAt || visible.has(row.id)) continue;
    visible.add(row.id);
    stack.push(...(children.get(row.id) ?? []));
  }
  return visible;
}
/** Includes removed intermediate nodes so a legacy tombstone cannot shield live descendants. */
export function commentSubtreeIds(
  rows: readonly Pick<CommentNode, 'id' | 'parentId'>[],
  rootId: string
): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of rows)
    if (row.parentId) {
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row.id);
      children.set(row.parentId, siblings);
    }
  const found = new Set<string>(),
    stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return found;
}
