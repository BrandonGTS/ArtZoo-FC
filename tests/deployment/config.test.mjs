import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const marker = 'SecretMustNeverAppear';
function fixture(t) {
  const scratch = resolve('.local');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, 'config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    'secrets',
    'media',
    'media/original',
    'media/derived',
    'media/avatars',
    'bundle',
    'bin'
  ])
    mkdirSync(join(root, name), { mode: 0o700 });
  const bundle = join(root, 'bundle');
  for (const [directory, names] of [
    [
      'scripts',
      [
        'deployment-images.sh',
        'deployment-maintenance.sh',
        'deployment-image-check.mjs',
        'deployment-compose-check.sh'
      ]
    ],
    ['deployment', ['compose.yaml', '.env.example', 'runtime-config.manifest']]
  ])
    for (const name of names) copyFileSync(join(repository, directory, name), join(bundle, name));
  const roles = ['web', 'worker', 'tools'];
  const tag = 'dev-abcdef123456-20261114000000-123';
  writeFileSync(
    join(bundle, 'images.tsv'),
    roles.map((role) => `${role}\tartzoo-${role}:${tag}\tsha256:${'a'.repeat(64)}\tlinux/amd64\n`).join('')
  );
  writeFileSync(
    join(bundle, 'images.env'),
    roles.map((role) => `ARTZOO_${role.toUpperCase()}_IMAGE=artzoo-${role}:${tag}\n`).join('')
  );
  writeFileSync(join(bundle, 'images.tar'), 'synthetic archive; config-check never imports images');
  writeFileSync(join(bundle, 'source.txt'), 'format=5\n');
  const seal = () =>
    writeFileSync(
      join(bundle, 'SHA256SUMS'),
      readdirSync(bundle)
        .filter((n) => n !== 'SHA256SUMS')
        .map(
          (n) =>
            `${createHash('sha256')
              .update(readFileSync(join(bundle, n)))
              .digest('hex')}  ${n}\n`
        )
        .join('')
    );
  seal();
  writeFileSync(join(root, 'bin/docker'), '#!/bin/sh\necho DOCKER_MUST_NOT_RUN >&2\nexit 99\n', {
    mode: 0o700
  });
  // Unit fixtures model the deployed UID/GID, independently of the CI runner's
  // account. Keep real filesystem modes and all unknown owners unchanged.
  const identity = `
id() { case "$1" in -u|-g) printf '1000\\n';; *) /usr/bin/id "$@";; esac; }
stat() {
  local result
  result=$(/usr/bin/stat "$@") || return $?
  if [[ "$1" == -c && "$2" == %u && "$result" == ${process.getuid()} ]]; then result=1000
  elif [[ "$1" == -c && "$2" == %u:%g:%a ]]; then
    result=\${result/#${process.getuid()}:${process.getgid()}:/1000:1000:}
  fi
  printf '%s\\n' "$result"
}
source "$1" "\${@:2}"
`;
  const base = {
    COMPOSE_PROJECT_NAME: 'artzoo',
    ARTZOO_MEDIA_ROOT: `${root}/media`,
    ARTZOO_PUBLIC_ORIGIN: 'https://localhost',
    POSTGRES_PASSWORD: 'a'.repeat(64),
    ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ARTZOO_MEDIA_BUDGET_ENABLED: '0'
  };
  const config = join(root, 'secrets/compose.env');
  const run = (changes = {}, extra = '') => {
    const entries = Object.entries({ ...base, ...changes }).filter(([, value]) => value !== undefined);
    const content = entries.map(([key, value]) => `${key}=${value}\n`).join('') + extra;
    writeFileSync(config, content, { mode: 0o600 });
    const before = readdirSync(join(root, 'secrets'));
    const result = spawnSync(
      'bash',
      [
        '-c',
        identity,
        'fixture',
        join(bundle, 'deployment-maintenance.sh'),
        'config-check',
        '--bundle',
        bundle,
        '--root',
        root
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }
      }
    );
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, new RegExp(`${marker}|DOCKER_MUST_NOT_RUN|${base.POSTGRES_PASSWORD}`));
    assert.ok(!output.includes(base.ARTZOO_INVITATION_KEY), 'invitation key must stay private');
    assert.deepEqual(readdirSync(join(root, 'secrets')), before);
    assert.equal(readFileSync(config, 'utf8'), content);
    return { status: result.status, output };
  };
  return { run, seal, bundle };
}
const sms = {
  ARTZOO_SMS_PROVIDER: 'aliyun-pnvs',
  ARTZOO_SMS_ACCESS_KEY_ID: marker,
  ARTZOO_SMS_ACCESS_KEY_SECRET: String.raw`'${marker}$#\x!\'"'`,
  ARTZOO_SMS_SIGN_NAME: "'公会 测试'",
  ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100001',
  ARTZOO_SMS_RESET_TEMPLATE_CODE: '100003'
};
test('config-check applies defaults, accepts complete SMS and quotas, never contacts Docker or writes files', (t) => {
  const f = fixture(t);
  for (const config of [
    {},
    sms,
    { ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES: '3456789', ARTZOO_MEDIA_DAILY_LIMIT_BYTES: '1234567' },
    {
      ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES: '9223372036854775807',
      ARTZOO_MEDIA_DAILY_LIMIT_BYTES: '9223372036854775807'
    },
    { ...sms, AUTH_SMS_DAILY_LIMIT: '10000' },
    { ...sms, ARTZOO_SMS_SIGN_NAME: '中'.repeat(128) },
    { ...sms, ARTZOO_SMS_SIGN_NAME: '😀'.repeat(64) }
  ]) {
    const result = f.run(config);
    assert.equal(result.status, 0, result.output);
  }
});
test('config-check lists missing, extra and malformed names together without exposing secrets', (t) => {
  const f = fixture(t);
  const result = f.run({ POSTGRES_PASSWORD: undefined, ARTZOO_HTTP_PORT: '70000', EXTRA_SETTING: marker });
  assert.equal(result.status, 1);
  for (const [category, key] of [
    ['缺失', 'POSTGRES_PASSWORD'],
    ['多余', 'EXTRA_SETTING'],
    ['格式不符', 'ARTZOO_HTTP_PORT']
  ])
    assert.match(result.output, new RegExp(`${category}：${key}`));
});
test('config-check rejects invalid quotas, SMS modes and fields, duplicate and unsafe dotenv values', (t) => {
  const f = fixture(t);
  const invalid = [
    ...['0', '-1', '01', '1.5', '1e3', '9223372036854775808', '999999999999999999999'].map((value) => [
      'ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES',
      value
    ]),
    ['ARTZOO_MEDIA_DAILY_LIMIT_BYTES', '10000000001'],
    ['ARTZOO_MEDIA_DAILY_LIMIT_BYTES', '0'],
    ['AUTH_SMS_DAILY_LIMIT', '0'],
    ['AUTH_SMS_DAILY_LIMIT', '10001'],
    ['ARTZOO_SMS_PROVIDER', 'unknown'],
    ['ARTZOO_SMS_PROVIDER', 'unconfigured,aliyun-pnvs'],
    ['ARTZOO_SMS_ACCESS_KEY_SECRET', marker],
    ['ARTZOO_MEDIA_BUDGET_ENABLED', '0,1']
  ];
  for (const [key, value] of invalid) {
    const result = f.run({ [key]: value });
    assert.equal(result.status, 1, key);
    assert.ok(result.output.includes(key));
  }
  for (const [key, value] of [
    ['ARTZOO_SMS_ACCESS_KEY_ID', undefined],
    ['ARTZOO_SMS_REGISTER_TEMPLATE_CODE', 'SMS_100001'],
    ['ARTZOO_SMS_RESET_TEMPLATE_CODE', '100001'],
    ['ARTZOO_SMS_SIGN_NAME', `' ${marker}'`],
    ['ARTZOO_SMS_SIGN_NAME', '中'.repeat(129)],
    ['ARTZOO_SMS_SIGN_NAME', '😀'.repeat(65)],
    ['ARTZOO_SMS_SIGN_NAME', `'\u00a0${marker}'`],
    ['ARTZOO_SMS_SIGN_NAME', `'${marker}\ufeff'`],
    ['ARTZOO_SMS_ACCESS_KEY_SECRET', `"${marker}"`],
    ['ARTZOO_SMS_ACCESS_KEY_SECRET', `$${marker}`],
    ['ARTZOO_SMS_ACCESS_KEY_SECRET', String.raw`'${marker}\\\'"'`],
    ['ARTZOO_SMS_ACCESS_KEY_SECRET', String.raw`'${marker}\'`]
  ]) {
    const result = f.run({ ...sms, [key]: value });
    assert.equal(result.status, 1, key);
    assert.ok(result.output.includes(key));
  }
  for (const extra of [
    `POSTGRES_PASSWORD=${marker}\n`,
    `NOT A NAME=${marker}\n`,
    `AUTH_SMS_DAILY_LIMIT=2\0${marker}\n`
  ])
    assert.equal(f.run({}, extra).status, 1);
});
test('adding a manifest field supplies validation and default without editing the maintenance script', (t) => {
  const f = fixture(t);
  const path = join(f.bundle, 'runtime-config.manifest');
  writeFileSync(path, readFileSync(path, 'utf8') + 'ARTZOO_EXAMPLE_LIMIT|optional|0|uint:8|2|web\n');
  f.seal();
  assert.equal(f.run().status, 0);
  assert.equal(f.run({ ARTZOO_EXAMPLE_LIMIT: '3' }).status, 0);
  const invalid = f.run({ ARTZOO_EXAMPLE_LIMIT: '9' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.output, /ARTZOO_EXAMPLE_LIMIT/);
});
test('config manifest must be present, checksummed, unmodified and a regular file', (t) => {
  for (const variant of ['missing', 'modified', 'unchecked', 'symlink']) {
    const f = fixture(t);
    const path = join(f.bundle, 'runtime-config.manifest');
    if (variant === 'modified') writeFileSync(path, 'changed');
    if (variant === 'missing' || variant === 'symlink') rmSync(path);
    if (variant === 'symlink') symlinkSync('source.txt', path);
    if (variant === 'unchecked') {
      const sums = join(f.bundle, 'SHA256SUMS');
      writeFileSync(sums, readFileSync(sums, 'utf8').replace(/^.*  runtime-config\.manifest\n/m, ''));
    }
    assert.equal(f.run().status, 1, variant);
  }
});

test('configuration and invitation cipher agree on canonical 32-byte Base64 keys', (t) => {
  const f = fixture(t);
  const valid = Array.from({ length: 16 }, (_, last) => {
    const bytes = Buffer.alloc(32, 255);
    bytes[0] = 251;
    bytes[31] = last;
    return bytes.toString('base64');
  });
  const invalid = [
    'b'.repeat(64),
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    Buffer.alloc(32, 255).toString('base64url'),
    valid[0].slice(0, 42) + 'B=',
    valid[0].slice(0, -1)
  ];
  for (const [keys, accepted] of [
    [valid, true],
    [invalid, false]
  ]) {
    for (const value of keys) {
      assert.equal(!!loadInvitationCipher({ ARTZOO_INVITATION_KEY: value }), accepted);
      const result = f.run({ ARTZOO_INVITATION_KEY: value });
      assert.equal(result.status, accepted ? 0 : 1, result.output);
      assert.ok(!result.output.includes(value), 'key must not appear in diagnostics');
      if (!accepted) assert.match(result.output, /ARTZOO_INVITATION_KEY/);
    }
  }
});
