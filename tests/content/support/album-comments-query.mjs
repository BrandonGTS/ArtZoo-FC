const compare = (a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id);
// Independent ancestor walk in the adapter; real SQL is validated separately in PG.
export function rawRows(dataset, values, metrics = {}) {
  const [scopeAlbum, scopePhoto, limit, offset] = values;
  const candidates = dataset.comments.filter((c) => c.albumId === scopeAlbum && c.photoId === scopePhoto);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const visible = candidates
    .filter((c) => {
      let current = c;
      const seen = new Set();
      while (current) {
        if (current.removedAt || seen.has(current.id)) return false;
        seen.add(current.id);
        if (current.parentId === null) return true;
        current = byId.get(current.parentId);
      }
      return false;
    })
    .sort(compare);
  const page = visible.slice(offset, limit === null ? undefined : offset + limit);
  metrics.hydratedComments = (metrics.hydratedComments ?? 0) + page.length;
  metrics.projectedMembers =
    (metrics.projectedMembers ?? 0) +
    new Set(page.flatMap((c) => [c.authorId, ...(c.parentId ? [byId.get(c.parentId).authorId] : [])])).size;
  metrics.hydratedMedia = metrics.hydratedMedia ?? 0;
  const person = (id) => {
    const p = dataset.people.find((p) => p.id === id);
    return { ...JSON.parse(JSON.stringify(p)), createdAt: +p.createdAt };
  };
  const rows = page.map((c) => {
    const media = dataset.media
      .filter((m) => m.commentId === c.id && !m.removedAt)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ id, width, height, frames }) => ({ id, width, height, frames }));
    metrics.hydratedMedia += media.length;
    return {
      ...c,
      total: BigInt(visible.length),
      author: person(c.authorId),
      replyTo: c.parentId ? person(byId.get(c.parentId).authorId) : null,
      media
    };
  });
  return rows.length ? rows : [{ id: null, total: BigInt(visible.length) }];
}
