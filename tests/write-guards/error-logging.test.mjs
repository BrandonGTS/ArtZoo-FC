import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '@artzoo/domain';
import { logUnexpectedHttpError } from '../../apps/web/server/http-error-log.ts';
import { failure } from '../../apps/web/server/auth/http.ts';
import { handleDaily } from '../../apps/web/server/daily/http.ts';

async function capture(run) {
  const previous = console.error,
    lines = [];
  console.error = (...args) => {
    assert.equal(args.length, 1);
    lines.push(args[0]);
  };
  try {
    return { value: await run(), lines, records: lines.map((line) => JSON.parse(line)) };
  } finally {
    console.error = previous;
  }
}
test('unknown Error produces only a static classification and unchanged 503 response', async () => {
  const error = new Error('phone=13800000000 token=private-secret postgres://private');
  error.code = 'sensitive-connection-string';
  const { value, lines, records } = await capture(() => failure(error, 'daily/http'));
  assert.equal(value.status, 503);
  assert.deepEqual(await value.json(), {
    ok: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后再试' }
  });
  assert.deepEqual(records, [{ service: 'web', route: 'daily/http', error: 'Error', code: null }]);
  assert.ok(!lines[0].includes('private') && !lines[0].includes('13800000000'));
});
test('recognized classifications retain useful Prisma and PostgreSQL codes', async () => {
  for (const code of ['P2028', 'P2034', '40P01', '40001', 'ECONNREFUSED']) {
    const error = Object.assign(new TypeError('private'), { code });
    const { records } = await capture(() => logUnexpectedHttpError(error, 'auth/http'));
    assert.deepEqual(records, [{ service: 'web', route: 'auth/http', error: 'TypeError', code }]);
  }
});
test('name, code and route cannot carry caller text or newlines', async () => {
  const { lines, records } = await capture(() =>
    logUnexpectedHttpError(
      {
        name: 'phone-13800000000\nsecret',
        code: 'token-P2028-private',
        message: 'secret',
        stack: 'secret'
      },
      '/api/members/private-account?token=secret'
    )
  );
  assert.deepEqual(records, [{ service: 'web', route: 'unknown', error: 'Error', code: null }]);
  assert.ok(!lines[0].includes('secret') && !lines[0].includes('\n'));
});
test('hostile getters, proxies, primitives and bigints cannot break logging', async () => {
  const values = [
    null,
    undefined,
    'secret',
    1n,
    Symbol('secret'),
    Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error('secret');
          }
        },
        code: {
          get() {
            throw new Error('secret');
          }
        }
      }
    ),
    new Proxy(
      {},
      {
        has() {
          throw new Error('secret');
        }
      }
    )
  ];
  for (const value of values) {
    const { records } = await capture(() => logUnexpectedHttpError(value, 'daily/http'));
    assert.deepEqual(records, [{ service: 'web', route: 'daily/http', error: 'Error', code: null }]);
  }
});
test('known business errors and existing Prisma uniqueness response are not logged', async () => {
  const { value, lines } = await capture(() =>
    failure(new AccountError('FORBIDDEN', '无管理权限', 403), 'auth/http')
  );
  assert.equal(value.status, 403);
  assert.deepEqual(await value.json(), { ok: false, error: { code: 'FORBIDDEN', message: '无管理权限' } });
  assert.deepEqual(lines, []);
  const conflict = await capture(() => failure({ code: 'P2002', message: 'private' }, 'daily/http'));
  assert.equal(conflict.value.status, 409);
  assert.deepEqual(conflict.lines, []);
});
test('P2028 remains a service unavailable response', async () => {
  const { value, records } = await capture(() =>
    failure(Object.assign(new Error('private'), { code: 'P2028' }), 'auth/http')
  );
  assert.equal(value.status, 503);
  assert.equal((await value.json()).error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(records[0].code, 'P2028');
});
test('a representative real HTTP adapter propagates its static route to the shared failure handler', async () => {
  // The existing SEC01 loader injects a service with no list method. This creates
  // a real TypeError at the adapter boundary without a database or SMS provider.
  const { value, records } = await capture(() =>
    handleDaily(new Request('http://localhost:3100/api/daily'), 'list')
  );
  assert.equal(value.status, 503);
  assert.deepEqual(records, [{ service: 'web', route: 'daily/http', error: 'TypeError', code: null }]);
});
test('a failing logger does not replace the HTTP response path', () => {
  const previous = console.error;
  console.error = () => {
    throw new Error('logger unavailable');
  };
  try {
    assert.doesNotThrow(() => logUnexpectedHttpError(new Error('private'), 'daily/http'));
  } finally {
    console.error = previous;
  }
});
