// Fed to Node on stdin inside disposable deployment containers; no host Node needed.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

const [mode, role, detail] = process.argv.slice(2);
if (mode === 'runtime') {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.equal(process.arch, 'x64');
  function scan(directory, storage = false) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue; // Third-party package metadata is not operator configuration.
      assert.ok(!/^(\.git|\.local|secrets|\.aws|\.ssh|\.npmrc|\.env.*)$/.test(entry.name));
      assert.ok(!/\.(pem|key|p12|pfx|dump|backup|sqlite|sqlite3|db|log|har|tap)$/.test(entry.name));
      assert.ok(!/^id_(rsa|ed25519)/.test(entry.name));
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path, storage || path === '/app/storage');
      else assert.ok(!storage, 'Image must not contain stored media');
    }
  }
  scan('/app');
  assert.ok(!Object.keys(process.env).some((key) => /SECRET|TOKEN|PASSWORD|^DATABASE_URL$/.test(key)));
} else if (mode === 'media') {
  const url =
    role === 'web'
      ? new URL('file:///app/packages/media/dist/bitmap-worker.mjs')
      : new URL('./bitmap-worker.mjs', import.meta.resolve('@artzoo/media/photo-processor'));
  assert.ok(existsSync(url));
  const sharp = createRequire(url)('sharp');
  async function decode(input) {
    const worker = new Worker(url, { execArgv: [], workerData: { input, maxPixels: 1 } });
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Bitmap check timed out')), 20000);
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`Bitmap exited without a result: ${code}`)));
      });
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
  const bmp = Buffer.alloc(58);
  bmp.write('BM');
  bmp.writeUInt32LE(58, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(4, 34);
  bmp[56] = 255;
  const result = await decode(bmp);
  assert.equal(result.ok, true);
  const png = Buffer.from(result.output);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const { data, info } = await sharp(png, { limitInputPixels: 1, failOn: 'warning' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.deepEqual([...data], [255, 0, 0]);
  const rejected = await decode(bmp.subarray(0, 54));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INCOMPLETE');
} else if (mode === 'http') {
  const origin = 'http://127.0.0.1:3100';
  let health;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) });
      break;
    } catch {
      await delay(500);
    }
  }
  assert.ok(health, 'Website did not start');
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false });
  for (const path of ['/artzoo/animal-v5.png', '/_next/image?url=%2Fartzoo%2Fanimal-v5.png&w=64&q=75']) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^image\//);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
} else if (mode === 'owner') {
  const owner = await import('./apps/web/server/auth/owner-initialization-console.ts');
  const ports = await import('./apps/web/server/auth/ports.ts');
  assert.equal(typeof owner.runOwnerInitialization, 'function');
  assert.equal(ports.mainlandChinaPhone.ready, true);
} else if (mode === 'database-module') {
  const db = await import('@artzoo/db');
  assert.equal(typeof db.PrismaClient, 'function');
  assert.equal(db.databaseConfigured(), false);
} else if (mode === 'worker-result') {
  const result = role
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find((row) => row.service === 'artzoo-next-worker');
  assert.ok(result);
  assert.equal(result.database, detail === 'missing' ? 'unconfigured' : 'ok');
  assert.deepEqual(result.failedSteps, []);
  if (detail === 'cleanup') {
    assert.equal(result.cleanupEnabled, true);
    assert.equal(result.cleanup.rateEvents, 1);
    assert.equal(result.cleanup.failed, 0);
  }
} else {
  throw new Error('Unknown deployment check');
}
console.log(`PASS: ${mode}`);
