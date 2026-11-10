// 统一测试入口。
//   node scripts/run-tests.mjs              运行 tests/ 下所有单元测试（*.test.mjs，不含 *.pg.test.mjs）
//   node scripts/run-tests.mjs --pg         只运行数据库测试（*.pg.test.mjs），需要 ARTZOO_TEST_DATABASE_URL
//   node scripts/run-tests.mjs tests/auth   只运行某个目录或某个文件
//
// 每个测试文件在独立进程中运行，自动加载 tests/_shared/loader.mjs、
// 测试文件所在目录（或上级目录，直到 tests/）中的 setup.mjs，
// 以及与测试文件同名的 <名称>.setup.mjs（只对这一个文件生效的替身）。
// 单元测试额外加载 tests/_shared/no-network.mjs，禁止任何真实网络连接。
// 任何文件失败、或者一个用例都没执行，结果都算失败。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');
const args = process.argv.slice(2);
const pg = args.includes('--pg');
const targets = args.filter((a) => !a.startsWith('--'));

if (pg && !process.env.ARTZOO_TEST_DATABASE_URL) {
  console.error('数据库测试需要 ARTZOO_TEST_DATABASE_URL（指向一次性的测试 PostgreSQL，绝不能是正式库）。');
  process.exit(1);
}

function collect(path, out) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      collect(join(path, name), out);
    }
  } else if (path.endsWith('.test.mjs') && path.endsWith('.pg.test.mjs') === pg) out.push(path);
  return out;
}
const roots = targets.length ? targets.map((t) => resolve(root, t)) : [testsDir];
const files = roots.flatMap((r) => collect(r, []));
if (!files.length) {
  console.error('没有找到测试文件。');
  process.exit(1);
}

function setupFor(file) {
  const found = [];
  for (let dir = dirname(file); dir.startsWith(testsDir); dir = dirname(dir)) {
    const setup = join(dir, 'setup.mjs');
    if (existsSync(setup)) found.unshift(setup);
    if (dir === testsDir) break;
  }
  const own = file.replace(/(\.pg)?\.test\.mjs$/, '.setup.mjs');
  if (existsSync(own)) found.push(own);
  return found;
}

function run(file) {
  const imports = [
    join(testsDir, '_shared/loader.mjs'),
    ...(pg ? [] : [join(testsDir, '_shared/no-network.mjs')]),
    ...setupFor(file)
  ];
  const argv = [
    ...imports.flatMap((i) => ['--import', pathToFileURL(i).href]),
    '--test',
    '--test-reporter=tap',
    file
  ];
  return new Promise((done) => {
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, NODE_ENV: 'test' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const count = (k) => Number(out.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? 0);
      const tests = count('tests'),
        fail = count('fail') + count('cancelled');
      done({
        file: relative(root, file),
        code,
        tests,
        pass: count('pass'),
        fail,
        ok: code === 0 && tests > 0 && fail === 0,
        out
      });
    });
  });
}

const limit = Math.max(1, Math.min(pg ? 1 : 4, cpus().length));
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: limit }, async () => {
    while (next < files.length) {
      const result = await run(files[next++]);
      results.push(result);
      console.log(`${result.ok ? '通过' : '失败'}  ${result.file}  （${result.pass}/${result.tests}）`);
    }
  })
);
const failed = results.filter((r) => !r.ok);
for (const r of failed)
  console.log(
    `\n──── ${r.file} ────\n${r.out
      .split('\n')
      .filter((l) => !/^\s*(ok|# Subtest)/.test(l))
      .slice(-60)
      .join('\n')}`
  );
const sum = (k) => results.reduce((n, r) => n + r[k], 0);
console.log(
  `\n共 ${results.length} 个文件、${sum('tests')} 个用例：通过 ${sum('pass')}，失败 ${sum('fail')}；失败文件 ${failed.length} 个。`
);
process.exit(failed.length ? 1 : 0);
