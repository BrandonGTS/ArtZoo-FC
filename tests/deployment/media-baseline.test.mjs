import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBaselineArguments, runBaselineCommand } from '../../scripts/media-baseline-cli.mjs';
import { deploymentMediaBaselineRoots } from '../../packages/media/src/media-baseline.ts';

test('maintenance arguments require explicit offline acknowledgement and exact database', () => {
  const env = { PGDATABASE: 'artzoo' };
  assert.equal(parseBaselineArguments(['--offline', '--expect-database', 'artzoo'], env), 'artzoo');
  for (const args of [
    [],
    ['--expect-database', 'artzoo'],
    ['--offline', '--expect-database', 'other'],
    ['--offline', '--expect-database', 'artzoo', '--force'],
    ['--offline', '--expect-database', '']
  ])
    assert.throws(() => parseBaselineArguments(args, env), /MEDIA_BASELINE_ARGUMENTS/);
});
test('deployment storage cannot silently skip redirected directories or local defaults', () => {
  const env = { NODE_ENV: 'production', ARTZOO_AVATAR_DIR: '/app/storage/avatars' };
  assert.deepEqual(deploymentMediaBaselineRoots(env), [
    '/app/storage/original',
    '/app/storage/derived',
    '/app/storage/avatars'
  ]);
  for (const patch of [
    { NODE_ENV: 'development' },
    { ARTZOO_AVATAR_DIR: '/elsewhere' },
    { ARTZOO_PHOTO_ORIGINAL_DIR: '/elsewhere' },
    { ARTZOO_KNOWLEDGE_DERIVED_DIR: '' },
    { ARTZOO_MEDIA_ORIGINAL_DIR: '/app/storage/original/photos' }
  ])
    assert.throws(() => deploymentMediaBaselineRoots({ ...env, ...patch }), /MEDIA_BASELINE_STORAGE_CONFIG/);
});
test('help and invalid invocation do not access the database or expose environment values', async () => {
  const output = [],
    oldLog = console.log,
    oldError = console.error;
  console.log = console.error = (...args) => output.push(args.join(' '));
  try {
    assert.equal(await runBaselineCommand(['--help'], {}), 0);
    assert.equal(await runBaselineCommand([], { PGPASSWORD: 'synthetic-do-not-print' }), 1);
    assert.match(output.join(' '), /Stop web, worker/);
    assert.doesNotMatch(output.join(' '), /synthetic-do-not-print/);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
});
