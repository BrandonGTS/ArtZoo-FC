// 仓库规则自动检查。
// 用法：
//   node scripts/check-rules.mjs                 只检查当前代码
//   node scripts/check-rules.mjs --base <git引用>  另外检查相对 <git引用> 的变化（迁移、依赖、改动规模）
//
// 允许站长放行的三种情况（在 GitHub PR 上加标签，CI 会设置对应环境变量）：
//   deps-approved               → ALLOW_DEPENDENCY_CHANGE=1   允许修改依赖
//   migration-rewrite-approved  → ALLOW_MIGRATION_REWRITE=1   允许修改或删除已有迁移
//   large-change-approved       → ALLOW_LARGE_CHANGE=1        允许一次新增超过 1000 行产品代码
//
// 基线文件 scripts/rules-baseline.json 记录"整理前就已存在的问题"。
// 检查只拦截新增的问题；已有问题修好后，请把基线里对应的数字或条目也删掉。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const LIMITS = {
  rootAgentsLines: 80,
  moduleAgentsLines: 40,
  docFileBytes: 100 * 1024,
  addedProductLines: 1000
};

const failures = [];
const notes = [];
const fail = (rule, detail, howToFix) => failures.push({ rule, detail, howToFix });

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function trackedFiles() {
  return git('ls-files', '-z').split('\0').filter(Boolean);
}
function readText(path) {
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function baseRefFromArgs() {
  const i = process.argv.indexOf('--base');
  const ref = i >= 0 ? process.argv[i + 1] : '';
  if (!ref || /^0+$/.test(ref)) return null;
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return ref;
  } catch {
    notes.push(`找不到基准提交 ${ref}，跳过"相对变化"类检查。`);
    return null;
  }
}

const baseline = JSON.parse(readFileSync('scripts/rules-baseline.json', 'utf8'));
const files = trackedFiles();
const isProductCode = (f) =>
  /^(apps|packages|plugins)\//.test(f) &&
  /\.(ts|tsx|mjs|js|cjs|py|css)$/.test(f) &&
  !/\.test\.|\/tests?\//.test(f) &&
  !f.startsWith('packages/db/prisma/migrations/');

// ── 1. 命名：不出现工单号、发布号、schema 号、日期 ─────────────────────
const NAMING_PATTERNS = [
  /rev\d{3,}/i,
  /(?<!\d)20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/,
  /release[-_]?\d+/i,
  /canonical\d+/i,
  /schema\d{2,}/i,
  /(?<![a-z])qc\d+/i,
  /batch\d+/i,
  /historical\d+/i,
  /fresh\d{2,}/i
];
const namingExempt = (f) =>
  f.startsWith('packages/db/prisma/migrations/') || /\/optimized\/[^/]+\.[0-9a-f]{8,}\./.test(f);
for (const f of files) {
  if (namingExempt(f)) continue;
  const hit = NAMING_PATTERNS.find((p) => p.test(f));
  if (hit) fail('命名', f, '文件和目录按产品模块命名；工单号、发布号、日期写在 commit message 里。');
}
for (const f of files.filter((f) => f.startsWith('.github/workflows/'))) {
  const text = readText(f);
  for (const line of text.split('\n')) {
    if (!/^\s{2}[\w-]+:\s*$|^\s+name:/.test(line)) continue;
    if (NAMING_PATTERNS.some((p) => p.test(line)))
      fail('命名', `${f}: ${line.trim()}`, 'CI 的 job 名称不要带发布号或日期。');
  }
  for (const line of text.split('\n'))
    if (/^\s+ref:\s*[0-9a-f]{7,40}\s*$/.test(line))
      fail('CI 只测当前代码', `${f}: ${line.trim()}`, 'CI 不能检出固定的历史提交。');
}

// ── 2. 证据文件不进仓库 ──────────────────────────────────────────────
for (const f of files) {
  const evidence =
    /\.(tap|har|sha256|log)$/.test(f) ||
    (/^(tests|docs)\//.test(f) &&
      /(before|after|verification|evidence|receipt|results?|manifest-proof)[^/]*\.json$/i.test(f));
  if (evidence) fail('证据文件', f, '执行日志、哈希、结果快照放在本机 .local/ 或 PR 描述里，不提交。');
}

// ── 3. 文档和规则文件的大小 ──────────────────────────────────────────
for (const f of files) {
  if (f.startsWith('docs/') && statSync(f).size > LIMITS.docFileBytes)
    fail(
      '文档过大',
      `${f}（${Math.round(statSync(f).size / 1024)} KB）`,
      '拆分或归档；单个文档不超过 100 KB。'
    );
  if (/(^|\/)AGENTS\.md$/.test(f)) {
    const lines = readText(f).split('\n').length;
    const limit = f === 'AGENTS.md' ? LIMITS.rootAgentsLines : LIMITS.moduleAgentsLines;
    if (lines > limit)
      fail(
        '规则文件过长',
        `${f}（${lines} 行，上限 ${limit}）`,
        '规则越长越容易被漏掉；能自动检查的规则请写进本脚本。'
      );
  }
}

// ── 4. 本机路径不进仓库 ──────────────────────────────────────────────
const MACHINE_PATH = /(^|[\s'"`(=])(\/home\/[^/\s'"`]+\/|[A-Za-z]:[\\/]Users[\\/])/m;
for (const f of files) {
  if (!/\.(md|ts|tsx|mjs|js|cjs|py|sh|json|ya?ml|css)$/.test(f)) continue;
  if (baseline.machinePaths.includes(f)) continue;
  if (MACHINE_PATH.test(readText(f))) fail('本机路径', f, '用相对路径，或从脚本自身位置推算仓库根目录。');
}

// ── 5. 测试不读取产品源码做断言 ──────────────────────────────────────
// 只检查测试用例文件本身；tests/_shared 里的加载器、数据库工具需要读取源码和迁移文件，不在此列。
const isTest = (f) => /\.test\.(m?[jt]sx?|cjs)$/.test(f);
for (const f of files.filter(isTest)) {
  if (baseline.sourceReadingTests.includes(f)) continue;
  const text = readText(f);
  if (
    /readFile(Sync)?\s*\(/.test(text) &&
    /(apps\/|packages\/|components\/|\.tsx?['"`]|\.css['"`])/.test(text)
  )
    fail(
      '测试读源码',
      f,
      '测试应调用代码、断言行为；不要读取源码文本做正则匹配。读测试数据请放 tests/fixtures/。'
    );
}

// ── 6. 服务端随机数与原生 SQL ────────────────────────────────────────
const serverCode = files.filter(
  (f) => /^(apps\/web\/server|apps\/worker|packages)\//.test(f) && isProductCode(f)
);
for (const f of serverCode) {
  if (/Math\.random\s*\(/.test(readText(f)))
    fail('服务端随机数', f, '服务端和抽奖逻辑用 node:crypto 的 randomInt / randomBytes。');
}
const unsafeSqlCount = files
  .filter(isProductCode)
  .reduce((n, f) => n + (readText(f).match(/\$(query|execute)RawUnsafe\s*\(/g) ?? []).length, 0);
if (unsafeSqlCount > baseline.unsafeRawSqlCount)
  fail(
    '原生 SQL',
    `$queryRawUnsafe/$executeRawUnsafe 共 ${unsafeSqlCount} 处，基线 ${baseline.unsafeRawSqlCount}`,
    '改用带参数的 tx.$queryRaw`...${值}` 模板写法。'
  );
else if (unsafeSqlCount < baseline.unsafeRawSqlCount)
  notes.push(`原生 SQL 已减少到 ${unsafeSqlCount} 处，可把基线 unsafeRawSqlCount 改为 ${unsafeSqlCount}。`);

// ── 7. CSS !important 只减不增 ───────────────────────────────────────
const importantCount = files
  .filter((f) => f.endsWith('.css') && !f.includes('/public/'))
  .reduce((n, f) => n + (readText(f).match(/!important/g) ?? []).length, 0);
if (importantCount > baseline.importantCount)
  fail(
    'CSS !important',
    `共 ${importantCount} 处，基线 ${baseline.importantCount}`,
    '新样式用 CSS Module 或提高选择器精度。'
  );
else if (importantCount < baseline.importantCount)
  notes.push(`!important 已减少到 ${importantCount} 处，可把基线 importantCount 改为 ${importantCount}。`);

// ── 8. 相对基准提交的变化 ────────────────────────────────────────────
const base = baseRefFromArgs();
if (base) {
  const changed = git('diff', '--name-status', '--no-renames', base, 'HEAD')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    });

  // 8a. 已有迁移只增不改
  const touchedMigrations = changed.filter(
    (c) => c.path.startsWith('packages/db/prisma/migrations/') && c.status !== 'A'
  );
  if (touchedMigrations.length && process.env.ALLOW_MIGRATION_REWRITE !== '1')
    for (const c of touchedMigrations)
      fail(
        '迁移只增不改',
        `${c.status} ${c.path}`,
        '新建一个迁移来修改结构；确需重写迁移，请站长在 PR 上加 migration-rewrite-approved 标签。'
      );

  // 8b. 依赖变化需要站长确认
  const manifests = changed.filter((c) =>
    /(^|\/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$/.test(c.path)
  );
  const depsOf = (ref, path) => {
    try {
      const p = JSON.parse(ref ? git('show', `${ref}:${path}`) : readFileSync(path, 'utf8'));
      return JSON.stringify([p.dependencies, p.devDependencies, p.peerDependencies, p.optionalDependencies]);
    } catch {
      return null;
    }
  };
  const depChanges = manifests.filter((c) =>
    c.path.endsWith('package.json') ? depsOf(base, c.path) !== depsOf(null, c.path) : true
  );
  if (depChanges.length && process.env.ALLOW_DEPENDENCY_CHANGE !== '1')
    for (const c of depChanges)
      fail(
        '依赖变化',
        `${c.status} ${c.path}`,
        '新增、升级或删除依赖需要站长同意；同意后在 PR 上加 deps-approved 标签。'
      );

  // 8c. 一次新增的产品代码行数
  let added = 0;
  for (const line of git('diff', '--numstat', '--no-renames', base, 'HEAD')
    .trim()
    .split('\n')
    .filter(Boolean)) {
    const [plus, , path] = line.split('\t');
    if (plus !== '-' && isProductCode(path)) added += Number(plus);
  }
  if (added > LIMITS.addedProductLines && process.env.ALLOW_LARGE_CHANGE !== '1')
    fail(
      '改动规模',
      `本次新增产品代码 ${added} 行，上限 ${LIMITS.addedProductLines}`,
      '先向站长提交设计说明；同意后在 PR 上加 large-change-approved 标签，或拆成几个小 PR。'
    );
  notes.push(`相对 ${base.slice(0, 12)}：改动 ${changed.length} 个文件，新增产品代码 ${added} 行。`);
} else {
  notes.push('未指定 --base，只检查了当前代码，没有检查迁移、依赖和改动规模。');
}

// ── 输出 ─────────────────────────────────────────────────────────────
for (const n of notes) console.log(`提示：${n}`);
if (failures.length) {
  console.error(`\n规则检查未通过，共 ${failures.length} 项：`);
  for (const f of failures) console.error(`\n[${f.rule}] ${f.detail}\n  怎么改：${f.howToFix}`);
  process.exit(1);
}
console.log('规则检查通过。');
