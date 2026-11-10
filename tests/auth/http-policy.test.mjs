import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecurityPolicy } from '../../apps/web/server/auth/security.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { handle } from '../../apps/web/server/auth/http.ts';

test('mainland phone accepts local/+86/0086 with permitted separators and normalizes identically', () => {
  for (const input of [
    '13800000001',
    '+8613800000001',
    '008613800000001',
    ' 138 0000-0001 ',
    '+86 138-0000-0001',
    '0086-138-0000-0001'
  ]) {
    assert.equal(mainlandChinaPhone.normalize(input), '+8613800000001');
  }
  for (const first of ['13', '14', '15', '16', '17', '18', '19'])
    assert.equal(mainlandChinaPhone.normalize(first + '800000001'), '+86' + first + '800000001');
  assert.equal(mainlandChinaPhone.ready, true);
  assert.equal(mainlandChinaPhone.defaultRegion, 'CN');
});
test('mainland phone rejects international/HK/Macau/Taiwan, wrong prefix/length and Unicode digits', () => {
  for (const input of [
    '+15550000001',
    '+85291234567',
    '+85361234567',
    '+886912345678',
    '8613800000001',
    '+8813800000001',
    '12800000001',
    '1380000000',
    '138000000001',
    '１３８０００００００１',
    '138\t00000001',
    '+86+8613800000001'
  ]) {
    assert.throws(
      () => mainlandChinaPhone.normalize(input),
      (e) => e.code === 'VALIDATION_ERROR' && Boolean(e.fieldErrors.phone)
    );
  }
});
test('public config advertises CN ready while SMS remains honestly unavailable', async () => {
  const response = await handle(new Request('http://localhost:3100/api/auth/config'), 'config'),
    body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.phone.ready, true);
  assert.equal(body.data.phone.defaultRegion, 'CN');
  assert.equal(body.data.sms.available, false);
  assert.equal(body.data.sms.mode, 'unconfigured');
  assert.equal(body.data.sessionDays, 30);
});
test('production local HTTP only explicit loopback canonical origins can disable Secure', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const origin = 'http://' + host + ':3100';
    assert.deepEqual(
      resolveSecurityPolicy({ nodeEnv: 'production', deploymentEnv: 'local', publicOrigin: origin }),
      { origin, secure: false, cookieName: 'artzoo-session' }
    );
  }
  const origin = 'https://localhost:3100';
  assert.deepEqual(
    resolveSecurityPolicy({ nodeEnv: 'production', deploymentEnv: 'local', publicOrigin: origin }),
    { origin, secure: true, cookieName: '__Host-artzoo-session' }
  );
});
test('production requires canonical HTTPS, unknown deployment and invalid local origins fail closed', () => {
  for (const environment of [
    { nodeEnv: 'production' },
    { nodeEnv: 'production', publicOrigin: 'http://localhost:3100' },
    { nodeEnv: 'production', publicOrigin: 'https://example.invalid/' },
    { nodeEnv: 'production', publicOrigin: 'https://user:pass@example.invalid' },
    { nodeEnv: 'production', publicOrigin: 'https://example.invalid?x=1' },
    { nodeEnv: 'production', publicOrigin: 'not a URL' },
    { deploymentEnv: 'unknown', publicOrigin: 'https://example.invalid' },
    { deploymentEnv: 'local', publicOrigin: 'http://192.168.1.2:3100' },
    { deploymentEnv: 'local', publicOrigin: 'http://localhost.evil.invalid' },
    { deploymentEnv: 'local', publicOrigin: 'http://localhost:3100/' },
    { deploymentEnv: 'local', publicOrigin: 'http://127.0.0.2' },
    { deploymentEnv: 'production', publicOrigin: 'http://example.invalid' }
  ])
    assert.throws(
      () => resolveSecurityPolicy(environment),
      (e) => e.code === 'SERVICE_UNAVAILABLE' && e.status === 503
    );
  for (const environment of [
    { nodeEnv: 'production', publicOrigin: 'https://example.invalid' },
    { nodeEnv: 'test', deploymentEnv: 'production', publicOrigin: 'https://example.invalid' }
  ]) {
    assert.deepEqual(resolveSecurityPolicy(environment), {
      origin: 'https://example.invalid',
      secure: true,
      cookieName: '__Host-artzoo-session'
    });
  }
});
test('development source policy follows request origin and HTTPS Secure setting', () => {
  assert.deepEqual(resolveSecurityPolicy({ nodeEnv: 'test' }, 'http://localhost:3100/login'), {
    origin: 'http://localhost:3100',
    secure: false,
    cookieName: 'artzoo-session'
  });
  const secure = resolveSecurityPolicy({ nodeEnv: 'test' }, 'https://localhost/login');
  assert.equal(secure.origin, 'https://localhost');
  assert.equal(secure.secure, true);
});
