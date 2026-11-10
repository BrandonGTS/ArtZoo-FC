// QQ 群内报名、通知投递与桥接的数据库测试。
// 绑定流程见 binding-key.pg.test.mjs，报名码见 signup-code.pg.test.mjs。
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';
import { input } from '../activities/support/activity-input.mjs';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { signupPostgresCases } from './support/signup-pg-cases.mjs';
import { notificationPostgresCases } from './support/notifications-pg-cases.mjs';
import { bridgePostgresCases } from './support/bridge-pg-cases.mjs';

test('QQ 群内报名、通知投递与桥接（数据库）', async (t) => {
  const f = await fixture({ accounts: 20 });
  try {
    const now = new Date('2030-06-01T10:00:00Z');
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
    const service = new ActivityService(auth),
      token = (i) => f.tokens[i],
      fresh = (extra = {}) => input({ idempotencyKey: randomUUID(), ...extra }),
      check = (name, fn) => t.test(name, fn);
    await signupPostgresCases({ f, auth, service, check, token, fresh });
    await notificationPostgresCases({ db: f.db, check, organizerId: f.ids[0] });
    await bridgePostgresCases({ f, auth, service, check, token, fresh });
  } finally {
    await f.cleanup();
  }
});
