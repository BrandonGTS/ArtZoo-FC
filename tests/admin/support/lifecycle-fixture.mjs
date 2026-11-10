// 账号停用 / 恢复的数据库测试夹具：新建空库，建超管、管理员、成员、朋友和被停用目标等账号。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDatabase } from '../../_shared/database.mjs';
export const body = (preview, extra = {}) => ({
  active: preview.active,
  expectedRevision: preview.account.lifecycleRevision,
  previewFingerprint: preview.previewFingerprint,
  confirmed: true,
  reason: '合成测试：确认账号生命周期影响',
  idempotencyKey: randomUUID(),
  ...extra
});
export const noPrivate = (value) => {
  const text = JSON.stringify(value);
  for (const key of ['passwordHash', 'tokenHash', 'passwordVersion'])
    assert.equal(text.includes('"' + key + '"'), false);
};
export function diagnostic(error, stage, secrets = []) {
  const adapter = error?.meta?.driverAdapterError,
    cause = adapter?.cause || error?.cause || {},
    meta = error?.meta || {};
  const clean = (value) => {
    let text = String(value ?? '')
      .split(/\r?\n/)[0]
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[connection redacted]');
    for (const secret of [...secrets, process.env.PGPASSWORD, 'NONLOGIN-SYNTHETIC'])
      if (secret) text = text.split(secret).join('[redacted]');
    return text
      .replace(/(?:Failing row|Detail|Parameters|Query):?.*/i, '[database details redacted]')
      .slice(0, 400);
  };
  const marker = String(error?.message || '').match(/(?:Database error|Raw query failed)\.[^\n]*/)?.[0];
  console.error(
    'ACCOUNT_LIFECYCLE_DIAGNOSTIC',
    JSON.stringify({
      stage,
      code: clean(error?.code),
      name: clean(error?.name),
      model: clean(meta.modelName),
      field: clean(meta.field_name || meta.column),
      dbCode: clean(cause.originalCode || cause.code),
      kind: clean(cause.kind),
      message: clean(cause.originalMessage || marker || error?.name)
    })
  );
}
export async function fixture() {
  const testDb = await createTestDatabase();
  const { AccountService } = await import('../../../apps/web/server/auth/service.ts'),
    { mainlandChinaPhone, unavailableSms } = await import('../../../apps/web/server/auth/ports.ts'),
    { tokenDigest } = await import('../../../apps/web/server/auth/crypto.ts');
  const db = testDb.db;
  const ids = {},
    tokens = {},
    people = {},
    sessionIds = {};
  let setupStage = 'identity',
    clock = new Date('2030-12-01T12:00:00Z');
  try {
    for (const key of ['owner', 'owner2', 'admin', 'member', 'friend', 'target', 'friendTarget', 'other']) {
      setupStage = 'account.create:' + key;
      const person = await db.account.create({
        data: {
          phone: 'lifecycle-' + randomUUID(),
          passwordHash: 'NONLOGIN-SYNTHETIC',
          displayName: '合成生命周期' + key,
          gameRegion: '合成大区',
          gameServer: '合成区服',
          membership: ['friend', 'friendTarget'].includes(key) ? 'FRIEND' : 'MEMBER',
          adminRole: key.startsWith('owner') ? 'SUPER_ADMIN' : key === 'admin' ? 'ADMIN' : 'NONE',
          activityPoints: key === 'target' ? 7 : 0,
          activityDecayAt: key === 'target' ? new Date(clock.getTime() + 7 * 86400000) : null
        }
      });
      ids[key] = person.id;
      people[key] = person;
      tokens[key] = randomBytes(32).toString('base64url');
      setupStage = 'session.create:' + key;
      const session = await db.accountSession.create({
        data: {
          accountId: person.id,
          tokenHash: tokenDigest(tokens[key]),
          expiresAt: new Date('2035-01-01T00:00:00Z')
        }
      });
      sessionIds[key] = session.id;
    }
    setupStage = 'expiredTargetSession.create';
    tokens.targetExpired = randomBytes(32).toString('base64url');
    await db.accountSession.create({
      data: {
        accountId: ids.target,
        tokenHash: tokenDigest(tokens.targetExpired),
        expiresAt: new Date('2000-01-01T00:00:00Z')
      }
    });
    setupStage = 'dailyPost.create';
    const preservedPost = await db.dailyPost.create({
      data: { authorId: ids.target, body: '合成保留内容，不应随账号停用删除', mentions: [] }
    });
    setupStage = 'dailyMedia.create';
    await db.dailyMedia.create({
      data: {
        ownerId: ids.target,
        postId: preservedPost.id,
        batchId: randomUUID(),
        batchIndex: 0,
        fingerprint: 'SYNTHETIC',
        mime: 'image/png',
        width: 1,
        height: 1,
        frames: 1
      }
    });
    setupStage = 'expiredActorSession.create';
    tokens.expired = randomBytes(32).toString('base64url');
    await db.accountSession.create({
      data: {
        accountId: ids.owner,
        tokenHash: tokenDigest(tokens.expired),
        expiresAt: new Date('2000-01-01T00:00:00Z')
      }
    });
    setupStage = 'auth.construct';
    const auth = new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    });
    setupStage = 'lifecycle.import-construct';
    const { AccountLifecycleService } = await import('../../../apps/web/server/account-lifecycle/service.ts');
    const service = new AccountLifecycleService(auth);
    const time = (hours) => new Date(clock.getTime() + hours * 3600000);
    async function activity({
      owner = ids.other,
      kind = 'future',
      scene = 'GAME',
      mode = 'SINGLE',
      seriesId = null,
      periodNumber = null,
      registered = ids.target,
      cancelled = false
    } = {}) {
      const startsAt = time(kind === 'future' ? 24 : kind === 'ongoing' ? -1 : -4),
        endsAt = time(kind === 'future' ? 26 : kind === 'ongoing' ? 1 : kind === 'boundary' ? 0 : -2);
      const row = await db.activity.create({
        data: {
          organizerId: owner,
          idempotencyKey: randomUUID(),
          requestFingerprint: 'SYNTHETIC',
          title: '合成生命周期 ' + scene + ' ' + mode + ' ' + kind,
          description: '独立合成数据',
          category: 'SOCIAL',
          scene,
          mode,
          seriesId,
          periodNumber,
          startsAt,
          endsAt,
          ...(scene === 'OFFLINE'
            ? {
                location: '合成地点',
                capacityUnlimited: true,
                registrationClosesAt: new Date(startsAt.getTime() - 3600000),
                completionEnabledAt: null
              }
            : {}),
          ...(cancelled ? { cancelledAt: time(-5), cancellationReason: '合成已取消' } : {})
        }
      });
      const seat = await db.activitySeat.create({ data: { activityId: row.id, position: 0, kind: 'ANY' } });
      const registration = registered
        ? await db.activityRegistration.create({
            data: {
              activityId: row.id,
              seatId: seat.id,
              accountId: registered,
              job: '武士',
              seatSnapshot: {
                id: seat.id,
                position: seat.position,
                groupKey: seat.groupKey,
                kind: seat.kind,
                role: seat.role,
                job: seat.job
              },
              attendanceStatus: 'PRESENT',
              attendanceRevision: 2,
              attendanceRecordedAt: time(-5),
              attendanceUpdatedAt: time(-5)
            }
          })
        : null;
      return { ...row, seat, registration };
    }
    async function team({ owner = ids.other, member = ids.target } = {}) {
      const row = await db.fixedTeam.create({
        data: {
          creatorId: owner,
          name: '合成生命周期固定队',
          description: '合成招募',
          idempotencyKey: randomUUID(),
          requestFingerprint: 'SYNTHETIC'
        }
      });
      const seats = [];
      for (let position = 0; position < 8; position++)
        seats.push(
          await db.teamSeat.create({
            data: {
              teamId: row.id,
              position,
              kind: 'ROLE',
              role: position < 2 ? 'TANK' : position < 4 ? 'HEALER' : 'DAMAGE'
            }
          })
        );
      const membership = member
        ? await db.teamMembership.create({
            data: { teamId: row.id, seatId: seats[4].id, accountId: member, position: 4, job: '武士' }
          })
        : null;
      const sessions = [];
      for (const kind of ['future', 'ongoing', 'ended', 'boundary']) {
        const startsAt = time(
            kind === 'future' ? 24 : kind === 'ongoing' ? -1 : kind === 'boundary' ? 0 : -4
          ),
          endsAt = time(kind === 'future' ? 26 : kind === 'ongoing' || kind === 'boundary' ? 1 : -2);
        const session = await db.teamSession.create({
          data: { teamId: row.id, startsAt, endsAt, state: 'CONFIRMED', confirmedAt: time(-6) }
        });
        const sessionMember = membership
          ? await db.teamSessionMember.create({
              data: {
                sessionId: session.id,
                timeVersion: 0,
                membershipId: membership.id,
                accountId: member,
                position: 4,
                job: '武士',
                confirmedStartsAt: startsAt,
                confirmedEndsAt: endsAt
              }
            })
          : null;
        sessions.push({ ...session, kind, sessionMember });
      }
      return { ...row, seats, membership, sessions };
    }
    async function impactFixture(target = ids.target) {
      const activities = [];
      for (const [scene, mode] of [
        ['GAME', 'SINGLE'],
        ['GAME', 'SERIES'],
        ['OFFLINE', 'SINGLE']
      ]) {
        const series =
          mode === 'SERIES'
            ? await db.activitySeries.create({
                data: {
                  weekdays: [1],
                  durationMinutes: 120,
                  totalPeriods: 4,
                  state: 'FORMED',
                  formedAt: time(-24)
                }
              })
            : null;
        for (const [index, kind] of ['future', 'ongoing', 'ended', 'boundary'].entries())
          activities.push(
            await activity({
              scene,
              mode,
              kind,
              registered: target,
              seriesId: series?.id,
              periodNumber: series ? index + 1 : null
            })
          );
      }
      activities.push(await activity({ registered: target, cancelled: true }));
      const owned = [];
      for (const kind of ['future', 'ongoing', 'ended', 'boundary'])
        owned.push(await activity({ owner: target, kind, registered: ids.member }));
      const ownedSeries = await db.activitySeries.create({
        data: { weekdays: [1], durationMinutes: 120, totalPeriods: 4, state: 'FORMED', formedAt: time(-24) }
      });
      for (const [index, kind] of ['ended', 'boundary', 'ongoing', 'future'].entries())
        owned.push(
          await activity({
            owner: target,
            kind,
            registered: ids.member,
            mode: 'SERIES',
            seriesId: ownedSeries.id,
            periodNumber: index + 1
          })
        );
      const allFutureOwnedSeries = await db.activitySeries.create({
        data: { weekdays: [1], durationMinutes: 120, totalPeriods: 2, state: 'FORMED', formedAt: time(-24) }
      });
      for (let index = 0; index < 2; index++)
        owned.push(
          await activity({
            owner: target,
            kind: 'future',
            registered: ids.member,
            mode: 'SERIES',
            seriesId: allFutureOwnedSeries.id,
            periodNumber: index + 1
          })
        );
      const ownedTeam = await team({ owner: target, member: ids.member }),
        otherTeam = await team({ member: target });
      const pending = await db.teamApplication.create({
        data: {
          teamId: otherTeam.id,
          seatId: otherTeam.seats[5].id,
          accountId: target,
          job: '武士',
          note: '合成待审'
        }
      });
      const substitutes = [];
      for (const s of otherTeam.sessions)
        substitutes.push(
          await db.teamSessionSubstitute.create({
            data: {
              sessionId: s.id,
              timeVersion: 0,
              position: 5,
              kind: 'REGISTERED',
              confirmedStartsAt: s.startsAt,
              confirmedEndsAt: s.endsAt,
              accountId: target,
              job: '武士',
              recordedById: ids.other,
              createdAt: time(-5)
            }
          })
        );
      return {
        activities,
        owned,
        ownedSeries,
        allFutureOwnedSeries,
        ownedTeam,
        otherTeam,
        pending,
        substitutes
      };
    }
    return {
      db,
      close: () => testDb.close(),
      auth,
      service,
      ids,
      tokens,
      people,
      sessionIds,
      time,
      activity,
      team,
      impactFixture,
      get now() {
        return clock;
      },
      set now(value) {
        clock = new Date(value);
      }
    };
  } catch (error) {
    diagnostic(error, setupStage, Object.values(tokens));
    await testDb.close();
    throw error;
  }
}
export async function effects(db) {
  const names = [
    'activityScoreChange',
    'activityPenalty',
    'activityOutbox',
    'teamNotification',
    'dailyPost',
    'dailyMedia',
    'albumPhoto',
    'activityShareMedia',
    'knowledgeImage',
    'knowledgeComment'
  ];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await db[name].count()])));
}
export async function state(db) {
  const names = [
    'account',
    'accountSession',
    'activity',
    'activityRegistration',
    'activitySeat',
    'fixedTeam',
    'teamMembership',
    'teamSession',
    'teamSessionMember',
    'teamSessionSubstitute',
    'teamApplication',
    'teamCommand',
    'teamNotification',
    'activityCommand',
    'activitySeries',
    'accountLifecycleCommand',
    'accountLifecycleAudit',
    'lotteryAccountStatus',
    'lotteryAccountFact'
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        (await db[name].findMany()).sort((a, b) =>
          String(a.id ?? a.sequence ?? a.accountId).localeCompare(String(b.id ?? b.sequence ?? b.accountId))
        )
      ])
    )
  );
}
