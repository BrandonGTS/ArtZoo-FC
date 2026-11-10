// 数据库测试的共用夹具：新建空库、跑完迁移，并建测试账号（默认 13 个；第 6 个是朋友，其余是正式成员）。
// QQ、固定队等模块也复用它，需要更多账号时传 { accounts: n }。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDatabase } from '../../_shared/database.mjs';
export async function fixture({ accounts = 13 } = {}) {
  const testDb = await createTestDatabase();
  const db = testDb.db;
  const ids = [],
    tokens = [];
  const { tokenDigest } = await import('../../../apps/web/server/auth/crypto.ts');
  const nonce = randomUUID().replaceAll('-', '');
  for (let i = 0; i < accounts; i++) {
    const account = await db.account.create({
      data: {
        phone: 'activity-fixture-' + nonce + '-' + i,
        passwordHash: 'NONLOGIN-TEST-MARKER',
        displayName: 'Activity Fixture ' + i,
        membership: i === 5 ? 'FRIEND' : 'MEMBER',
        adminRole: 'NONE'
      }
    });
    ids.push(account.id);
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
  return { db, ids, tokens, pool: testDb.pool, cleanup: () => testDb.close() };
}
export function noPrivate(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      /^(phone|phoneMasked|passwordHash|tokenHash|token|sessionToken|adminRole|idempotencyKey|requestHash|requestFingerprint|payload|deduplicationKey)$/.test(
        key
      ),
      false,
      'private key in DTO: ' + key
    );
    noPrivate(child);
  }
}
export const beijing = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
