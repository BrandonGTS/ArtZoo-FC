import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QqOfficialSignupService } from '../../../apps/web/server/qq-official/signup.ts';
import { dutyPresetSeats } from '../../../packages/domain/src/index.ts';

// Called only by the coordinating isolated database harness after all migrations.
// This module neither creates a database nor opens a default application connection.
export async function signupPostgresCases({ f, auth, service, check, token, fresh }) {
  const signup = new QqOfficialSignupService(auth),
    scope = { appId: 'signup-test-' + randomUUID(), botId: 'synthetic-bot', groupOpenId: 'synthetic-group' };
  const members = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, 'member-' + i]));
  const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
  for (const i of [1, 2, 3, 4, 5])
    await f.db.qqOfficialBinding.create({
      data: {
        ...scope,
        accountId: f.ids[i],
        memberOpenId: members[i],
        confirmedAt: auth.now()
      }
    });
  async function publish(extra = {}) {
    const body = fresh({
      dutySelection: { type: 'OTHER', name: 'Synthetic full party', partyComposition: 'FULL' },
      seats: dutyPresetSeats('FULL').map((s) => s.requirement),
      ...extra
    });
    const activity = (await service.create(body, token(0))).activity,
      refIdx = randomUUID();
    await f.db.qqOfficialMessage.create({
      data: { ...scope, deliveryId: randomUUID(), refIdx, activityId: activity.id }
    });
    return { activity, refIdx };
  }
  const send = (i, ref, text = '报名 H1 白魔', s = scope) => signup.registerReply(s, members[i], ref, text);
  await check(
    'QQ exact reply scope and binding gates reject foreign references and unbound senders',
    async () => {
      const { activity, refIdx } = await publish();
      for (const patch of [{ groupOpenId: 'other' }, { appId: 'other' }, { botId: 'other' }])
        await reject(() => send(1, refIdx, '报名 H1 白魔', { ...scope, ...patch }), 'NOT_FOUND');
      await reject(() => send(1, randomUUID()), 'NOT_FOUND');
      await reject(() => signup.registerReply(scope, 'unbound', refIdx, '报名 H1 白魔'), 'FORBIDDEN');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: activity.id } }), 0);
    }
  );
  await check(
    'QQ binds canonical job and seat without issuing sessions; identical retry only replays',
    async () => {
      const { activity, refIdx } = await publish(),
        before = await f.db.accountSession.count();
      assert.equal((await send(5, refIdx)).replayed, false);
      assert.equal((await send(5, refIdx)).replayed, true);
      const registrations = await f.db.activityRegistration.findMany({ where: { activityId: activity.id } });
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].accountId, f.ids[5]);
      assert.equal(registrations[0].seatId, activity.seats[2].id);
      assert.equal(registrations[0].job, '白魔法师');
      await reject(() => send(5, refIdx, '报名 H2 学者'), 'CONFLICT');
      assert.equal(await f.db.accountSession.count(), before);
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: activity.id, kind: 'REGISTRATION_CREATED' } }),
        1
      );
    }
  );
  await check(
    'QQ last-seat contention uses existing serialized transaction and creates one winner',
    async () => {
      const { activity, refIdx } = await publish();
      const results = await Promise.allSettled([1, 2].map((i) => send(i, refIdx)));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: activity.id } }), 1);
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: activity.id, kind: 'REGISTRATION_CREATED' } }),
        1
      );
    }
  );
  await check('QQ same-account simultaneous requests cannot occupy two seats', async () => {
    const { activity, refIdx } = await publish();
    const results = await Promise.allSettled(
      ['报名 H1 白魔', '报名 H2 学者'].map((text) => send(3, refIdx, text))
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
    assert.equal(
      await f.db.activityRegistration.count({ where: { activityId: activity.id, accountId: f.ids[3] } }),
      1
    );
  });
  await check('QQ alliance requires explicit exact group and preserves job requirements', async () => {
    const { activity, refIdx } = await publish({
      dutySelection: { type: 'OTHER', name: 'Synthetic alliance', partyComposition: 'ALLIANCE' },
      seats: dutyPresetSeats('ALLIANCE').map((s) => s.requirement)
    });
    await reject(() => send(4, refIdx), 'VALIDATION_ERROR');
    await reject(() => send(4, refIdx, '报名 B队 MT 白魔'), 'VALIDATION_ERROR');
    await send(4, refIdx, '报名 B队 H1 白魔');
    const registration = await f.db.activityRegistration.findFirstOrThrow({
      where: { activityId: activity.id, accountId: f.ids[4] }
    });
    assert.equal(registration.seatId, activity.seats[9].id);
  });
}
