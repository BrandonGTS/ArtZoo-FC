// Test helper: read real category pages; no synthetic all-category server endpoint.
import assert from 'node:assert/strict';
export async function readFiveCategories(messages, token, query = '') {
  const items = [],
    pages = [],
    scope = new URL('http://synthetic/' + query).searchParams.get('scope') || 'all';
  let unreadCount, categoryUnread;
  for (const category of ['comments', 'likes', 'recruitment', 'participation', 'system']) {
    const first = await messages.inbox(
      new URL(`http://synthetic/?category=${category}&scope=${scope}`),
      token
    );
    assert.equal(first.category, category);
    assert.ok(first.items.every((item) => item.category === category));
    unreadCount = first.unreadCount;
    categoryUnread = first.categoryUnread;
    const rows = [...first.items];
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await messages.inbox(
        new URL(`http://synthetic/?category=${category}&scope=${scope}&page=${page}`),
        token
      );
      assert.equal(next.page, page);
      rows.push(...next.items);
    }
    assert.equal(rows.length, first.total);
    assert.equal(new Set(rows.map((item) => item.id)).size, rows.length);
    items.push(...rows);
    pages.push({ category, total: first.total, totalPages: first.totalPages });
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  return { items, total: items.length, unreadCount, categoryUnread, pages };
}
