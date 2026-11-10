import { randomUUID } from 'node:crypto';
import { fixture, beijing, noPrivate } from '../../activities/support/pg-fixture.mjs';
export { beijing, noPrivate };
export function body(ids = null, group = null) {
  return {
    idempotencyKey: randomUUID(),
    name: 'Synthetic team',
    description: 'Synthetic recruitment',
    dutyName: 'Synthetic duty',
    progress: '阶段一',
    strategy: '文字攻略',
    commonTimes: '周二晚间，时间可协调',
    qqGroupId: group,
    seats: Array.from({ length: 8 }, (_, position) => ({
      position,
      requirement: { kind: 'ROLE', role: position < 2 ? 'TANK' : position < 4 ? 'HEALER' : 'DAMAGE' },
      ...(ids
        ? {
            memberId: ids[position] ?? null,
            memberJob: ids[position] ? (position < 2 ? '骑士' : position < 4 ? '白魔法师' : '武士') : null
          }
        : {})
    }))
  };
}
// Clean creation plus genuine API onboarding; body(ids) remains for rejection tests.
export const cleanBody = (group = null) => body(null, group);
export async function setupTeamMembers(team, memberIds, { accountIds, apply, decide, get }) {
  for (const [position, accountId] of memberIds.entries()) {
    if (!accountId) continue;
    const actor = accountIds.indexOf(accountId);
    if (actor < 0) throw Error('Setup actor must belong to isolated fixture');
    await apply(
      team,
      command(team, {
        position,
        job: position < 2 ? '骑士' : position < 4 ? '白魔法师' : '武士',
        note: 'Synthetic fixture onboarding'
      }),
      actor
    );
    team = await get(team);
    const a = team.applications.find((a) => a.person.id === accountId && a.state === 'PENDING');
    if (a) {
      await decide(team, command(team, { applicationId: a.id, decision: 'ACCEPT' }));
      team = await get(team);
    }
    if (team.seats[position]?.member?.person.id !== accountId) throw Error('Setup seat not occupied');
  }
  return team;
}
export async function createTeamWithMembers(service, f, ids = [], group = null) {
  return setupTeamMembers((await service.create(cleanBody(group), f.tokens[0])).team, ids, {
    accountIds: f.ids,
    apply: (t, c, i) => service.apply(t.id, c, f.tokens[i]),
    decide: (t, c) => service.decide(t.id, c, f.tokens[0]),
    get: (t) => service.get(t.id, f.tokens[0])
  });
}
export function command(team, fields = {}) {
  return { idempotencyKey: randomUUID(), expectedRevision: team.revision, ...fields };
}
// 每个测试文件用独立的空库，结束时整个库被删除，不需要逐表清理。
export async function teamFixture() {
  return fixture();
}
