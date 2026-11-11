// 后台管理数据库测试夹具：新建空库，建 7 个不同身份的账号（超管、管理员、成员、朋友……）。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDatabase } from '../../_shared/database.mjs';
export async function fixture() {
  const testDb = await createTestDatabase();
  const db = testDb.db;
  const { tokenDigest } = await import('../../../apps/web/server/auth/crypto.ts');
  const ids = [],
    tokens = [],
    people = [];
  try {
    const roles = [
      ['MEMBER', 'SUPER_ADMIN'],
      ['MEMBER', 'ADMIN'],
      ['MEMBER', 'NONE'],
      ['FRIEND', 'NONE'],
      ['FRIEND', 'ADMIN'],
      ['FRIEND', 'SUPER_ADMIN'],
      ['MEMBER', 'NONE']
    ];
    for (const [index, [membership, adminRole]] of roles.entries()) {
      const account = await db.account.create({
        data: {
          phone: 'admin-test-' + randomUUID(),
          passwordHash: 'NONLOGIN-SYNTHETIC',
          displayName: [
            '合成超管',
            '合成管理员',
            '月见团子',
            '朋友泡泡',
            '合成朋友管理员',
            '合成另一超管',
            '木槿眠'
          ][index],
          membership,
          adminRole
        }
      });
      ids.push(account.id);
      people.push(account);
      const token = randomBytes(32).toString('base64url');
      tokens.push(token);
      await db.accountSession.create({
        data: {
          accountId: account.id,
          tokenHash: tokenDigest(token),
          expiresAt: new Date('2035-01-01T00:00:00Z')
        }
      });
    }
    const activity = await db.activity.create({
      data: {
        organizerId: ids[2],
        idempotencyKey: randomUUID(),
        requestFingerprint: 'synthetic-management-preservation',
        title: '合成业务保持活动',
        description: '管理命令不得改变此记录',
        category: 'SOCIAL',
        startsAt: new Date('2030-12-01T10:00:00Z'),
        endsAt: new Date('2030-12-01T12:00:00Z')
      }
    });
    return {
      db,
      close: () => testDb.close(),
      ids,
      tokens,
      people,
      activity,
      roles: { superAdmin: 0, admin: 1, member: 2, friend: 3, friendAdmin: 4, otherSuper: 5, spare: 6 }
    };
  } catch (error) {
    await testDb.close();
    throw error;
  }
}
export const roleBody = (row, adminRole = row.adminRole === 'ADMIN' ? 'NONE' : 'ADMIN', extra = {}) => ({
  adminRole,
  expectedRole: row.adminRole,
  expectedRevision: row.adminRoleRevision,
  reason: '合成管理员权限调整原因',
  idempotencyKey: randomUUID(),
  ...extra
});
export function noPrivate(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      /^(phone|passwordHash|tokenHash|token|sessionToken|idempotencyKey|requestFingerprint|result|passwordVersion)$/.test(
        key
      ),
      false,
      'private DTO key ' + key
    );
    noPrivate(child);
  }
}
export async function effects(db) {
  return {
    activities: await db.activity.findMany({ orderBy: { id: 'asc' } }),
    registrations: await db.activityRegistration.count(),
    outbox: await db.activityOutbox.count(),
    scores: await db.activityScoreChange.count(),
    penalties: await db.activityPenalty.count(),
    albumNotices: await db.albumNotification.count(),
    dailyNotices: await db.dailyNotification.count(),
    teamNotices: await db.teamNotification.count(),
    lotteryNotices: await db.lotteryNotification.count(),
    wishNotices: await db.wishNotification.count(),
    knowledgeNotices: await db.knowledgeNotification.count()
  };
}
export async function snapshot(db) {
  return {
    accounts: await db.account.findMany({
      select: { id: true, adminRole: true, adminRoleRevision: true, membership: true },
      orderBy: { id: 'asc' }
    }),
    audits: await db.adminManagementAudit.findMany({ orderBy: { id: 'asc' } }),
    commands: await db.adminManagementCommand.findMany({ orderBy: { id: 'asc' } })
  };
}
export function observe(db, after) {
  return new Proxy(db, {
    get(target, member) {
      if (member === '$transaction')
        return (fn, ...options) => target.$transaction((tx) => fn(observeTransaction(tx, after)), ...options);
      if (['adminManagementCommand', 'adminManagementAudit', 'invitation', 'account'].includes(member))
        return observeTransaction(target, after)[member];
      const value = target[member];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
function observeTransaction(tx, after) {
  return new Proxy(tx, {
    get(target, member) {
      if (['adminManagementCommand', 'adminManagementAudit', 'invitation', 'account'].includes(member))
        return new Proxy(target[member], {
          get(delegate, method) {
            const value = delegate[method];
            return typeof value !== 'function'
              ? value
              : async (...args) => {
                  const result = await value.apply(delegate, args);
                  await after({ member: String(member), method: String(method), args, result, tx: target });
                  return result;
                };
          }
        });
      const value = target[member];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
