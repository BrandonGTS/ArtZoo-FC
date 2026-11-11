import { location, otherLocation } from './support/game-location.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTestAccountService } from './support/runtime-stub.mjs';
import { MemoryDb } from './support/memory-db.mjs';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { loadSmsSender } from '../../apps/web/server/auth/sms-config.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { tokenDigest, verifySecret } from '../../apps/web/server/auth/crypto.ts';

// File-local cookie context; loader still prevents any real database acquisition.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/headers')
      return { url: new URL('./support/cookies-stub.mjs', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }
});
const { handle } = await import('../../apps/web/server/auth/http.ts');
const complete = {
  ARTZOO_SMS_PROVIDER: 'aliyun-pnvs',
  ARTZOO_SMS_ACCESS_KEY_ID: 'syntheticId',
  ARTZOO_SMS_ACCESS_KEY_SECRET: 'syntheticSecret!$#',
  ARTZOO_SMS_SIGN_NAME: '测试签名',
  ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100001',
  ARTZOO_SMS_RESET_TEMPLATE_CODE: '100003'
};
const fields = [...Object.keys(complete), 'ARTZOO_DEPLOYMENT_ENV', 'ARTZOO_PUBLIC_ORIGIN'];
const origin = 'http://localhost:3100';
const local = { ARTZOO_DEPLOYMENT_ENV: 'local', ARTZOO_PUBLIC_ORIGIN: origin };
const headers = { origin, 'content-type': 'application/json', 'x-artzoo-request': '1' };
const post = (action, body) =>
  handle(
    new Request(origin + '/api/auth/' + action, { method: 'POST', headers, body: JSON.stringify(body) }),
    action
  );
async function isolated(environment, transport, action) {
  const previous = Object.fromEntries(fields.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const key of fields) delete process.env[key];
    Object.assign(process.env, local, environment);
    globalThis.fetch = transport;
    return await action();
  } finally {
    setTestAccountService(undefined);
    globalThis.fetch = originalFetch;
    for (const key of fields) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
function assertNoSecrets(raw, extra = []) {
  for (const key of Object.keys(complete)) {
    assert.equal(raw.includes(key), false);
    assert.equal(raw.includes(complete[key]), false);
  }
  for (const value of extra) assert.equal(raw.includes(value), false);
}

for (const [name, environment, expectedStatus, expectedSms] of [
  ['complete', complete, 200, { mode: 'aliyun', available: true }],
  ['absent', {}, 200, { mode: 'unconfigured', available: false }],
  ['incomplete', { ...complete, ARTZOO_SMS_ACCESS_KEY_SECRET: '' }, 503, null],
  ['unknown provider', { ...complete, ARTZOO_SMS_PROVIDER: 'aliyun' }, 503, null],
  ['wrong purpose template', { ...complete, ARTZOO_SMS_RESET_TEMPLATE_CODE: '100001' }, 503, null]
]) {
  test('real HTTP config: ' + name + ' without DB/network or secret serialization', async () => {
    let calls = 0;
    await isolated(
      environment,
      async () => {
        calls++;
        throw Error('Network forbidden');
      },
      async () => {
        const response = await handle(new Request(origin + '/api/auth/config'), 'config');
        assert.equal(response.status, expectedStatus);
        const raw = await response.text(),
          body = JSON.parse(raw);
        if (expectedSms) {
          assert.equal(body.ok, true);
          assert.deepEqual(body.data.sms, expectedSms);
          assert.equal(body.data.sessionDays, 30);
          assert.equal(body.data.phone.defaultRegion, 'CN');
        } else {
          assert.equal(body.ok, false);
          assert.equal(body.error.code, 'SMS_UNAVAILABLE');
        }
        assertNoSecrets(raw);
        assert.equal(calls, 0);
      }
    );
  });
}

for (const [purpose, template] of [
  ['REGISTER', '100001'],
  ['RESET_PASSWORD', '100003']
]) {
  for (const providerFails of [false, true]) {
    test(
      'HTTP/config/service/PNVS ' +
        purpose +
        (providerFails ? ' sanitized failure retains quota' : ' local verification success'),
      async () => {
        let calls = 0,
          sentCode;
        const transport = async (url, init) => {
          calls++;
          const request = new URL(url),
            parameters = request.searchParams;
          assert.equal(request.origin, 'https://dypnsapi.aliyuncs.com');
          assert.equal(parameters.get('TemplateCode'), template);
          const variables = JSON.parse(parameters.get('TemplateParam'));
          assert.deepEqual(Object.keys(variables).sort(), ['code', 'min']);
          assert.equal(variables.min, '5');
          assert.match(variables.code, /^\d{6}$/);
          assert.equal(parameters.get('ReturnVerifyCode'), 'false');
          assert.equal(parameters.get('AutoRetry'), '0');
          assert.equal(init.redirect, 'error');
          sentCode = variables.code;
          return Response.json({
            Code: providerFails ? 'BUSINESS_ERROR' : 'OK',
            Success: !providerFails,
            Message: 'syntheticSecret!$#',
            Model: { VerifyCode: 'provider-secret-code' }
          });
        };
        await isolated(complete, transport, async () => {
          const db = new MemoryDb(),
            now = new Date('2026-10-13T00:00:00Z');
          const phone = '+8613800000001',
            invitationToken = 'I'.repeat(43);
          let invitation;
          if (purpose === 'REGISTER') {
            invitation = await db.invitation.create({
              data: {
                tokenHash: tokenDigest(invitationToken),
                membership: 'MEMBER',
                createdById: 'synthetic-inviter',
                createdAt: now,
                expiresAt: new Date(+now + 86400000)
              }
            });
          } else {
            await db.account.create({
              data: {
                phone,
                passwordHash: 'synthetic-old-hash',
                membership: 'MEMBER',
                adminRole: 'NONE',
                createdAt: now
              }
            });
          }
          // Same real loader used by runtime and config; only DB acquisition is replaced.
          const service = new AccountService(db, {
            phone: mainlandChinaPhone,
            sms: loadSmsSender(process.env),
            environment: 'test',
            now: () => now
          });
          setTestAccountService(service);
          const config = await handle(new Request(origin + '/api/auth/config'), 'config');
          assert.deepEqual((await config.json()).data.sms, { mode: 'aliyun', available: true });
          assert.equal(calls, 0);
          const requestBody = {
            phone,
            purpose,
            ...(invitation ? { invitationToken } : {}),
            // HTTP input must not override server-owned PNVS fields.
            TemplateCode: '100005',
            min: '999',
            code: '999999'
          };
          const response = await post('verification-codes', requestBody);
          assert.equal(response.status, providerFails ? 503 : 200);
          const raw = await response.text(),
            body = JSON.parse(raw);
          assertNoSecrets(raw, [phone, sentCode, 'provider-secret-code', invitationToken]);
          assert.equal(calls, 1);
          assert.equal(db.rows.verificationCode.length, 1);
          const record = db.rows.verificationCode[0];
          assert.equal(record.purpose, purpose);
          assert.equal(+record.expiresAt - +record.createdAt, 300000);
          assert.notEqual(record.codeHash, sentCode);
          assert.equal(await verifySecret(sentCode, record.codeHash), true);
          // Both successful and failed deliveries still consume the existing 60-second quota.
          const limited = await post('verification-codes', requestBody);
          assert.equal(limited.status, 429);
          assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
          assert.equal(calls, 1);
          assert.equal(db.rows.verificationCode.length, 1);
          if (providerFails) {
            assert.equal(body.error.code, 'SMS_UNAVAILABLE');
            assert.ok(record.invalidatedAt);
            assert.equal(record.deliveredAt, null);
          } else {
            assert.equal(body.ok, true);
            assert.ok(record.deliveredAt);
            assert.equal(record.invalidatedAt, null);
            const action = purpose === 'REGISTER' ? 'register' : 'reset-password';
            const confirmed = await post(action, {
              phone,
              displayName: '测试玩家',
              ...location,
              invitationToken,
              code: sentCode,
              password: 'synthetic-new!7',
              confirmPassword: 'synthetic-new!7'
            });
            assert.equal(confirmed.status, purpose === 'REGISTER' ? 201 : 200);
            assert.equal((await confirmed.json()).ok, true);
            assert.ok(db.rows.verificationCode[0].consumedAt);
            const account = db.rows.account.find((account) => account.phone === phone);
            assert.equal(account.adminRole, 'NONE');
            assert.equal(await verifySecret('synthetic-new!7', account.passwordHash), true);
          }
        });
      }
    );
  }
}
