import test from 'node:test';
import assert from 'node:assert/strict';
const { messageSummary } = await import('../../apps/web/server/messages/service.ts');
for (const [kind, title, pattern] of [
  ['REGISTRATION_CONFIRMED', '报名成功', /你已报名/],
  ['SERIES_READY', '长期活动满员，等待成团确认', /首期开场前确认成团/],
  ['SERIES_FORMED', '长期活动已成团', /按各期安排参加/]
])
  test('new private event summary ' + kind, () => {
    const row = messageSummary({
      id: 'event:synthetic',
      sourceId: 'synthetic',
      source: 'event',
      kind,
      createdAt: new Date('2030-12-01'),
      readAt: null,
      deletedAt: null,
      activityId: 'synthetic-activity',
      activityTitle: 'Fallback title',
      participantName: null,
      payload: { activityTitle: 'Synthetic title', activityLink: 'https://evil.invalid/' },
      notices: null,
      pointsBefore: null,
      pointsAfter: null
    });
    assert.equal(row.title, title);
    assert.match(row.body, pattern);
    assert.match(row.body, /Synthetic title/);
    assert.equal(row.link.href, '/activities/synthetic-activity');
    assert.ok(!JSON.stringify(row).includes('evil.invalid'));
    assert.deepEqual(Object.keys(row).sort(), ['id', 'title', 'body', 'createdAt', 'readAt', 'link'].sort());
  });
