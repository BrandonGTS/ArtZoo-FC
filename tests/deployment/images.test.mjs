import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../scripts/deployment-images.sh', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = `sha256:${'a'.repeat(64)}`;
const ref = 'artzoo-web:git-abcdef123456-20261112000000-123';
const files = [
  'images.tar',
  'images.tsv',
  'source.txt',
  'deployment-images.sh',
  'deployment-image-check.mjs'
];
function fixture(t, manifest = `web\t${ref}\t${id}\tlinux/amd64\n`, actual = id) {
  const directory = mkdtempSync(join(tmpdir(), 'artzoo-deployment-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'bundle');
  const bin = join(directory, 'bin');
  const log = join(directory, 'docker-calls');
  mkdirSync(bundle);
  mkdirSync(bin);
  for (const file of files)
    writeFileSync(join(bundle, file), file === 'images.tsv' ? manifest : 'test payload\n');
  writeFileSync(
    join(bundle, 'SHA256SUMS'),
    files
      .map(
        (file) =>
          `${createHash('sha256')
            .update(readFileSync(join(bundle, file)))
            .digest('hex')}  ${file}\n`
      )
      .join('')
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ARTZOO_TEST_DOCKER_LOG"
case "$*" in
  *'image inspect'*) printf '%s linux/amd64\\n' '${actual}' ;;
  *' info'|*'ps --all --quiet'*|*'network ls --quiet'*) ;;
  *) echo 'unexpected Docker operation' >&2; exit 89 ;;
esac
`,
    { mode: 0o755 }
  );
  writeFileSync(join(bin, 'sudo'), '#!/usr/bin/env bash\nexit 99\n', { mode: 0o755 });
  return {
    bundle,
    bin,
    calls: () => {
      try {
        return readFileSync(log, 'utf8');
      } catch {
        return '';
      }
    },
    run: (...args) =>
      spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTZOO_TEST_DOCKER_LOG: log }
      })
  };
}
test('help works without a Docker connection', (t) => {
  const f = fixture(t);
  const result = f.run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /build/);
  assert.equal(f.calls(), '');
});
test('a matching version can be imported repeatedly without loading or starting containers', (t) => {
  const f = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(f.run('import', f.bundle).status, 0);
  assert.doesNotMatch(f.calls(), /image load| run | start /);
});
test('the last manifest record is checked even without a final newline', (t) => {
  const f = fixture(t, `web ${ref} ${id} linux/amd64`);
  assert.equal(f.run('import', f.bundle).status, 0);
});
test('a cleanup inventory failure is reported as failure', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bin, 'docker'),
    `#!/usr/bin/env bash
case "$*" in
  *'image inspect'*) printf '%s linux/amd64\\n' '${id}' ;;
  *'ps --all --quiet'*) exit 89 ;;
esac
`
  );
  const result = f.run('import', f.bundle);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /artzoo.image-check=/);
});
test('corrupt payload is rejected before Docker is contacted', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bundle, 'images.tar'), 'corrupt');
  assert.equal(f.run('import', f.bundle).status, 1);
  assert.equal(f.calls(), '');
});
test('checksum traversal is rejected before reading another file', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bundle, 'SHA256SUMS'), `${'a'.repeat(64)}  ../outside\n`);
  assert.equal(f.run('import', f.bundle).status, 1);
  assert.equal(f.calls(), '');
});
test('duplicate manifest roles and unexpected image references are refused', (t) => {
  for (const manifest of [
    `web ${ref} ${id} linux/amd64\nweb ${ref} ${id} linux/amd64\n`,
    `web other-project:latest ${id} linux/amd64\n`
  ]) {
    const f = fixture(t, manifest);
    assert.equal(f.run('import', f.bundle).status, 1);
    assert.equal(f.calls(), '');
  }
});
test('an existing tag with a different image ID is never overwritten', (t) => {
  const f = fixture(t, undefined, `sha256:${'b'.repeat(64)}`);
  assert.equal(f.run('import', f.bundle).status, 1);
  assert.doesNotMatch(f.calls(), /image load/);
});
test('output inside the source repository and unknown commands are refused', (t) => {
  const f = fixture(t);
  const result = f.run('build', '--output', root, '--allow-dirty');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发布目录必须位于仓库外/);
  assert.equal(f.run('publish').status, 1);
  assert.equal(f.calls(), '');
});
test('database verification requires worker and tools before Docker is contacted', (t) => {
  const f = fixture(t);
  assert.equal(f.run('check', f.bundle, '--database').status, 1);
  assert.equal(f.calls(), '');
});
