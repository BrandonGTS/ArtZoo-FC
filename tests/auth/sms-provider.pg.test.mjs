// 用真实的阿里云短信适配器（签名、模板、参数），但把网络传输换成本地假实现，
// 在真实 PostgreSQL 上走完注册和找回密码；同时确认没有任何真实网络请求、日志里不泄露密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { loadSmsSender } from '../../apps/web/server/auth/sms-config.ts';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { hashSecret, verifySecret, tokenDigest, opaqueToken } from '../../apps/web/server/auth/crypto.ts';
import { GAME_SERVER_REGIONS } from '../../packages/domain/src/account-contract.ts';
import { createTestDatabase } from '../_shared/database.mjs';

const output = console.log.bind(console),
  originalFetch = globalThis.fetch;

const originalError = console.error,
  originalLog = console.log;
const capturedLogs = [],
  calls = [],
  secrets = [];
let networkAttempts = 0;
console.log = (...args) => capturedLogs.push(args.map(String).join(' '));
console.error = (...args) => capturedLogs.push(args.map(String).join(' '));
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('GlobalNetworkForbidden');
};
test('短信：真实阿里云适配器 + 本地假传输 + 完整注册与找回（真实 PostgreSQL）', async (t) => {
  const testDb = await createTestDatabase();
  const { db, pool } = testDb;
  t.after(() => testDb.close());
  const config = {
    ARTZOO_SMS_PROVIDER: 'aliyun-pnvs',
    ARTZOO_SMS_ACCESS_KEY_ID: 'Dummy' + randomBytes(8).toString('hex'),
    ARTZOO_SMS_ACCESS_KEY_SECRET: 'DummySecret' + randomBytes(16).toString('hex'),
    ARTZOO_SMS_SIGN_NAME: '隔离测试签名',
    ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100001',
    ARTZOO_SMS_RESET_TEMPLATE_CODE: '100003'
  };
  secrets.push(config.ARTZOO_SMS_ACCESS_KEY_ID, config.ARTZOO_SMS_ACCESS_KEY_SECRET);
  let responseMode = 'success',
    now = new Date('2030-02-01T08:00:00Z'),
    sequence = 0;
  const phone = () => {
    const value = '+86138' + String(++sequence).padStart(8, '0');
    secrets.push(value, value.slice(3));
    return value;
  };
  const password = 'synthetic!8';
  secrets.push(password);
  const transport = async (url, init) => {
    const request = new URL(url),
      params = request.searchParams,
      headers = new Headers(init.headers);
    assert.equal(request.origin, 'https://dypnsapi.aliyuncs.com');
    assert.equal(request.pathname, '/');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
    assert.equal(headers.get('host'), 'dypnsapi.aliyuncs.com');
    assert.equal(headers.get('x-acs-action'), 'SendSmsVerifyCode');
    assert.equal(headers.get('x-acs-version'), '2017-05-25');
    assert.match(headers.get('x-acs-date'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(headers.get('x-acs-signature-nonce'), /^[a-f0-9-]{36}$/);
    const emptyHash = createHash('sha256').update('').digest('hex');
    assert.equal(headers.get('x-acs-content-sha256'), emptyHash);
    assert.equal(params.get('CountryCode'), '86');
    assert.equal(params.get('SignName'), config.ARTZOO_SMS_SIGN_NAME);
    for (const [key, value] of Object.entries({
      ValidTime: '300',
      Interval: '60',
      CodeLength: '6',
      CodeType: '1',
      DuplicatePolicy: '1',
      ReturnVerifyCode: 'false',
      AutoRetry: '0'
    }))
      assert.equal(params.get(key), value);
    const variables = JSON.parse(params.get('TemplateParam'));
    assert.deepEqual(Object.keys(variables).sort(), ['code', 'min']);
    assert.match(variables.code, /^\d{6}$/);
    assert.equal(variables.min, '5');
    const authorization = headers.get('authorization');
    const match = /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})$/.exec(
      authorization
    );
    assert.ok(match);
    assert.equal(match[1], config.ARTZOO_SMS_ACCESS_KEY_ID);
    const names = match[2].split(';');
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(names, [
      'host',
      'x-acs-action',
      'x-acs-content-sha256',
      'x-acs-date',
      'x-acs-signature-nonce',
      'x-acs-version'
    ]);
    const encode = (value) =>
      encodeURIComponent(value).replace(
        /[!'()*]/g,
        (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()
      );
    const query = [...params.keys()]
      .sort()
      .map((key) => encode(key) + '=' + encode(params.get(key)))
      .join('&');
    const canonicalHeaders = names.map((key) => key + ':' + headers.get(key).trim() + '\n').join('');
    const canonical = ['POST', '/', query, canonicalHeaders, names.join(';'), emptyHash].join('\n');
    const expectedSignature = createHmac('sha256', config.ARTZOO_SMS_ACCESS_KEY_SECRET)
      .update('ACS3-HMAC-SHA256\n' + createHash('sha256').update(canonical).digest('hex'))
      .digest('hex');
    assert.equal(match[3], expectedSignature);
    secrets.push(variables.code, authorization, request.href);
    calls.push({
      phone: params.get('PhoneNumber'),
      code: variables.code,
      template: params.get('TemplateCode')
    });
    if (responseMode === 'throw') throw new Error('SyntheticTransportUncertain');
    return Response.json({
      Code: responseMode === 'failure' ? 'SYNTHETIC_ERROR' : 'OK',
      Success: responseMode === 'success',
      Message: 'provider-response-must-not-leak',
      Model: { VerifyCode: 'provider-code-must-not-leak' }
    });
  };
  const sms = loadSmsSender(config, transport);
  assert.equal(sms.mode, 'aliyun');
  assert.equal(sms.available, true);
  assert.equal(calls.length, 0);
  const service = new AccountService(db, {
    phone: mainlandChinaPhone,
    sms,
    environment: 'test',
    now: () => new Date(now)
  });
  const seed = async (role = 'NONE') =>
    db.account.create({
      data: {
        phone: phone(),
        passwordHash: await hashSecret(password),
        membership: 'MEMBER',
        adminRole: role,
        createdAt: now
      }
    });
  const inviter = await seed('ADMIN');
  const invitation = async () => {
    const token = opaqueToken();
    secrets.push(token);
    return {
      token,
      row: await db.invitation.create({
        data: {
          tokenHash: tokenDigest(token),
          tokenCiphertext: 'synthetic',
          membership: 'MEMBER',
          createdById: inviter.id,
          createdAt: now,
          expiresAt: new Date(+now + 86400000)
        }
      })
    };
  };
  const check = (name, fn) => t.test(name, fn);
  const expect = (code) => (error) => error?.code === code;
  let registered;
  await check('real-adapter-registration-template-signature-and-full-PG-registration', async () => {
    const destination = phone(),
      inv = await invitation(),
      before = calls.length;
    const result = await service.sendCode({
      phone: destination,
      purpose: 'REGISTER',
      invitationToken: inv.token,
      TemplateCode: '100005',
      code: '999999'
    });
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1);
    assert.equal(call.template, '100001');
    assert.equal(call.phone, destination.slice(3));
    const row = await db.verificationCode.findFirst({ where: { phone: destination } });
    assert.ok(row.deliveredAt);
    assert.equal(await verifySecret(call.code, row.codeHash), true);
    assert.ok(!JSON.stringify(result).includes(call.code));
    const region = GAME_SERVER_REGIONS[0];
    await service.register({
      phone: destination,
      invitationToken: inv.token,
      code: call.code,
      password,
      confirmPassword: password,
      displayName: 'PNVS-isolated-registration',
      gameRegion: region.region,
      gameServer: region.servers[0]
    });
    registered = await db.account.findUnique({ where: { phone: destination } });
    assert.ok(registered);
    assert.equal(registered.adminRole, 'NONE');
    assert.equal(await verifySecret(password, registered.passwordHash), true);
    assert.ok((await db.verificationCode.findUnique({ where: { id: row.id } })).consumedAt);
    assert.equal((await db.invitation.findUnique({ where: { id: inv.row.id } })).usedById, registered.id);
  });
  now = new Date('2030-02-02T08:00:00Z');
  let resetMetadata, knownElapsed, unknownElapsed;
  await check('real-adapter-reset-template-delivered-hash-new-password-and-session-revocation', async () => {
    const oldOne = await service.login({ phone: registered.phone, password }, 'ip:sms-one'),
      oldTwo = await service.login({ phone: registered.phone, password }, 'ip:sms-two');
    const before = calls.length,
      start = performance.now();
    resetMetadata = await service.sendCode({ phone: registered.phone, purpose: 'RESET_PASSWORD' });
    knownElapsed = performance.now() - start;
    assert.ok(knownElapsed >= 999, 'one-second floor allows only one millisecond of timer granularity');
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1);
    assert.equal(call.template, '100003');
    assert.equal(call.phone, registered.phone.slice(3));
    const row = await db.verificationCode.findFirst({
      where: { phone: registered.phone },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(row.deliveredAt);
    assert.equal(await verifySecret(call.code, row.codeHash), true);
    const next = 'resetpw8';
    secrets.push(next);
    await service.resetPassword({
      phone: registered.phone,
      code: call.code,
      password: next,
      confirmPassword: next
    });
    for (const token of [oldOne.token, oldTwo.token]) assert.equal((await service.session(token)).user, null);
    const changed = await db.account.findUnique({ where: { id: registered.id } });
    assert.equal(changed.passwordVersion, 1);
    assert.equal(await verifySecret(next, changed.passwordHash), true);
  });
  await check(
    'unknown-reset-zero-provider-calls-virtual-invalid-code-matching-response-and-floor',
    async () => {
      const missing = phone(),
        before = calls.length,
        start = performance.now();
      const result = await service.sendCode({ phone: missing, purpose: 'RESET_PASSWORD' });
      unknownElapsed = performance.now() - start;
      assert.ok(unknownElapsed >= 999, 'one-second floor allows only one millisecond of timer granularity');
      assert.deepEqual(result, resetMetadata);
      assert.equal(calls.length, before);
      const row = await db.verificationCode.findFirst({ where: { phone: missing } });
      assert.ok(row.invalidatedAt);
      assert.equal(+row.expiresAt, +row.createdAt);
      assert.equal(row.deliveredAt, null);
      await assert.rejects(
        () =>
          service.resetPassword({
            phone: missing,
            code: '123456',
            password: 'resetpw8',
            confirmPassword: 'resetpw8'
          }),
        expect('CODE_INVALID')
      );
      assert.equal(calls.length, before);
    }
  );
  for (const purpose of ['REGISTER', 'RESET_PASSWORD'])
    await check('provider-failure-' + purpose + '-503-no-retry-persistent-budget', async () => {
      now = new Date(+now + 86400000);
      responseMode = 'failure';
      const existing = purpose === 'RESET_PASSWORD' ? await seed() : null,
        destination = existing?.phone ?? phone(),
        inv = purpose === 'REGISTER' ? await invitation() : null;
      const body = { phone: destination, purpose, ...(inv ? { invitationToken: inv.token } : {}) },
        before = calls.length;
      await assert.rejects(
        () => service.sendCode(body),
        (error) => error.code === 'SMS_UNAVAILABLE' && error.status === 503
      );
      assert.equal(calls.length, before + 1);
      const call = calls.at(-1);
      assert.equal(call.template, purpose === 'REGISTER' ? '100001' : '100003');
      const row = await db.verificationCode.findFirst({ where: { phone: destination } });
      assert.ok(row.invalidatedAt);
      assert.equal(row.deliveredAt, null);
      assert.equal(await verifySecret(call.code, row.codeHash), true);
      await assert.rejects(
        () => service.sendCode(body),
        (error) => error.code === 'RATE_LIMITED' && error.status === 429
      );
      assert.equal(calls.length, before + 1);
      assert.equal(await db.verificationCode.count({ where: { phone: destination } }), 1);
      if (existing)
        await assert.rejects(
          () =>
            service.resetPassword({
              phone: destination,
              code: call.code,
              password: 'resetpw8',
              confirmPassword: 'resetpw8'
            }),
          expect('CODE_INVALID')
        );
      else {
        assert.equal(await db.account.count({ where: { phone: destination } }), 0);
        assert.equal((await db.invitation.findUnique({ where: { id: inv.row.id } })).usedAt, null);
      }
    });
  await check('uncertain-transport-error-not-retried-and-global-fetch-never-used', async () => {
    now = new Date(+now + 86400000);
    responseMode = 'throw';
    const existing = await seed(),
      before = calls.length;
    await assert.rejects(
      () => service.sendCode({ phone: existing.phone, purpose: 'RESET_PASSWORD' }),
      (error) => error.code === 'SMS_UNAVAILABLE' && error.status === 503
    );
    assert.equal(calls.length, before + 1);
    assert.equal(networkAttempts, 0);
    const row = await db.verificationCode.findFirst({ where: { phone: existing.phone } });
    assert.ok(row.invalidatedAt);
    assert.equal(row.deliveredAt, null);
  });
  await check(
    'captured-application-logs-contain-no-phone-code-password-signature-or-response-secrets',
    async () => {
      secrets.push('provider-response-must-not-leak', 'provider-code-must-not-leak');
      const raw = capturedLogs.join('\n');
      for (const secret of secrets) assert.ok(!raw.includes(secret));
      assert.equal(networkAttempts, 0);
    }
  );
});
