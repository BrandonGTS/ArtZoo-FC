import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTestAccountService } from './support/runtime-stub.mjs';
import { MemoryDb } from './support/memory-db.mjs';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
// node:test isolates each test file in its own process; existing 43 cases retain real next/headers.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/headers')
      return { url: new URL('./support/cookies-stub.mjs', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }
});
const { handle } = await import('../../apps/web/server/auth/http.ts');
const validHeaders = {
  origin: 'http://localhost:3100',
  'content-type': 'application/json',
  'x-artzoo-request': '1'
};
const request = (headers = validHeaders, body = '{}') =>
  new Request('http://localhost:3100/api/auth/register', { method: 'POST', headers, body });
function setup() {
  const db = new MemoryDb();
  const actualService = new AccountService(db, {
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    environment: 'test',
    now: () => new Date('2026-10-13T00:00:00Z'),
    writeSourceLimit: 2
  });
  let quotaCalls = 0,
    businessCalls = 0;
  setTestAccountService({
    async limitWriteSource(source) {
      quotaCalls++;
      await actualService.limitWriteSource(source);
    },
    async register() {
      businessCalls++;
      return { registered: true, requiresLogin: true };
    }
  });
  return { db, quotaCalls: () => quotaCalls, businessCalls: () => businessCalls };
}
for (const [name, headers, body, status] of [
  ['foreign Origin', { ...validHeaders, origin: 'https://evil.invalid' }, '{}', 403],
  ['missing Origin', { 'content-type': 'application/json', 'x-artzoo-request': '1' }, '{}', 403],
  ['form content type', { ...validHeaders, 'content-type': 'application/x-www-form-urlencoded' }, '{}', 403],
  [
    'missing custom request header',
    { origin: validHeaders.origin, 'content-type': 'application/json' },
    '{}',
    403
  ],
  ['cross-site fetch metadata', { ...validHeaders, 'sec-fetch-site': 'cross-site' }, '{}', 403],
  ['malformed JSON', validHeaders, '{bad json', 400],
  ['invalid JSON shape', validHeaders, '[]', 400]
]) {
  test('HTTP quota regression: ' + name + ' rejected without consuming legitimate write quota', async () => {
    const f = setup();
    try {
      const response = await handle(request(headers, body), 'register');
      assert.equal(response.status, status);
      assert.equal(f.quotaCalls(), 0, 'rejected request must not invoke the legitimate quota counter');
      assert.equal(
        f.db.rows.accountRateEvent.length,
        0,
        'rejected request must not reserve any legitimate quota'
      );
      assert.equal(f.businessCalls(), 0);
    } finally {
      setTestAccountService(undefined);
    }
  });
}
test('HTTP quota regression: legitimate writes still reserve quota and third request is 429', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 2; i++) {
      const response = await handle(request(), 'register');
      assert.equal(response.status, 201);
    }
    const limited = await handle(request(), 'register'),
      body = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(limited.headers.get('retry-after'), '900');
    assert.equal(f.quotaCalls(), 3);
    assert.equal(f.businessCalls(), 2);
    assert.equal(f.db.rows.accountRateEvent.length, 4);
  } finally {
    setTestAccountService(undefined);
  }
});
