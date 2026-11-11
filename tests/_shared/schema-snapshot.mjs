// 数据库结构快照：把"跑完全部迁移后的空库"整理成一份稳定、可读的文本，用来逐行比对。
//
// 为什么不用 pg_dump：pg_dump 要求客户端和数据库主版本一致，CI 和每台电脑装的版本不一定相同；
// 这里直接查询 PostgreSQL 自己的系统目录，只依赖项目已有的 pg 依赖，在哪里跑结果都一样。
//
// 快照包含 public 模式下的全部结构：
//   枚举、表（列的顺序、类型、默认值、非空、排序规则）、约束（主键、外键、唯一、检查、排他）、
//   独立索引（包括带条件的唯一索引）、触发器、函数、序列、视图、行级安全、表权限，
//   以及迁移写入的初始数据（随机 ID 和时间换成占位符，其余原样记录）。
// 不包含：Prisma 自己的 _prisma_migrations 表（测试和快照都不经过 Prisma 跑迁移）。

import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (name) => '"' + name.replaceAll('"', '""') + '"';

function placeholder(value) {
  if (value === null) return 'NULL';
  if (value instanceof Date) return '<时间>';
  if (typeof value === 'string' && UUID.test(value)) return '<随机ID>';
  return JSON.stringify(value);
}

/** @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client */
export async function schemaSnapshot(client) {
  const out = [];
  const section = (title) => out.push('', '## ' + title);
  const rows = async (sql, params) => (await client.query(sql, params)).rows;

  const schemas = await rows(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg\\_%'
      ORDER BY nspname`
  );
  const extensions = await rows(
    `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`
  );
  out.push('# 数据库结构快照（由 pnpm db:snapshot --write 生成，请勿手工修改）');
  section('其他模式与扩展');
  out.push('模式：' + (schemas.map((r) => r.nspname).join('、') || '无'));
  out.push('扩展：' + (extensions.map((r) => r.extname).join('、') || '无'));

  section('枚举');
  for (const e of await rows(
    `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`
  ))
    out.push(`${q(e.typname)} = ${e.labels.join(' | ')}`);

  section('函数');
  for (const f of await rows(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
      ORDER BY p.proname, args`
  ))
    out.push('', `### ${f.proname}(${f.args})`, f.def.trim());

  section('序列');
  for (const s of await rows(
    `SELECT c.relname, s.seqtypid::regtype AS type, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcycle,
            d.refobjid::regclass AS owner_table, a.attname AS owner_column
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_sequence s ON s.seqrelid = c.oid
       LEFT JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i')
       LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname`
  ))
    out.push(
      `${q(s.relname)} ${s.type} start ${s.seqstart} step ${s.seqincrement} min ${s.seqmin} max ${s.seqmax}` +
        (s.seqcycle ? ' cycle' : '') +
        (s.owner_table ? ` 属于 ${s.owner_table}.${q(s.owner_column)}` : '')
    );

  section('视图');
  for (const v of await rows(
    `SELECT c.relname, c.relkind, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v','m') ORDER BY c.relname`
  ))
    out.push('', `### ${q(v.relname)}${v.relkind === 'm' ? '（物化）' : ''}`, v.def.trim());

  section('表');
  const tables = await rows(
    `SELECT c.oid, c.relname, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
            c.reloptions, c.relacl::text AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname`
  );
  for (const t of tables) {
    const flags = [
      t.relpersistence === 'u' && '不记日志（UNLOGGED）',
      t.relrowsecurity && '行级安全',
      t.relforcerowsecurity && '强制行级安全',
      t.reloptions && '选项 ' + t.reloptions.join(','),
      t.acl && '权限 ' + t.acl
    ].filter(Boolean);
    out.push('', `### ${q(t.relname)}${flags.length ? '（' + flags.join('；') + '）' : ''}`);
    for (const c of await rows(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attidentity, a.attgenerated,
              pg_get_expr(d.adbin, d.adrelid) AS def,
              CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS coll
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [t.oid]
    )) {
      const parts = [`  列 ${q(c.attname)} ${c.type}`];
      if (c.coll) parts.push(`COLLATE ${q(c.coll)}`);
      if (c.attnotnull) parts.push('NOT NULL');
      if (c.attidentity)
        parts.push(
          c.attidentity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY'
        );
      if (c.attgenerated) parts.push(`GENERATED ALWAYS AS (${c.def}) STORED`);
      else if (c.def !== null) parts.push(`DEFAULT ${c.def}`);
      out.push(parts.join(' '));
    }
    for (const k of await rows(
      `SELECT conname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
        WHERE conrelid = $1 ORDER BY conname`,
      [t.oid]
    ))
      out.push(`  约束 ${q(k.conname)} ${k.def}`);
    for (const i of await rows(
      `SELECT ic.relname, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
        WHERE i.indrelid = $1
          AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid)
        ORDER BY ic.relname`,
      [t.oid]
    ))
      out.push(`  索引 ${i.def}`);
    for (const g of await rows(
      `SELECT tgname, pg_get_triggerdef(oid, true) AS def, tgenabled FROM pg_trigger
        WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`,
      [t.oid]
    ))
      out.push(`  触发器 ${g.def}${g.tgenabled === 'O' ? '' : `（启用状态 ${g.tgenabled}）`}`);
    for (const p of await rows(
      `SELECT policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
      [t.relname]
    ))
      out.push(
        `  策略 ${q(p.policyname)} ${p.permissive} ${p.cmd} ${p.roles} USING (${p.qual}) CHECK (${p.with_check})`
      );
  }

  section('初始数据（迁移写入的行；随机 ID 和时间用占位符代替）');
  for (const t of tables) {
    const data = await rows(`SELECT * FROM ${q(t.relname)}`);
    if (!data.length) continue;
    const lines = data
      .map(
        (r) =>
          '  ' +
          Object.entries(r)
            .map(([k, v]) => `${k}=${placeholder(v)}`)
            .join(', ')
      )
      .sort();
    out.push('', `### ${q(t.relname)}（${data.length} 行）`, ...lines);
  }
  return out.join('\n').trim() + '\n';
}

export const SNAPSHOT_FILE = new URL('../../packages/db/prisma/schema-snapshot.txt', import.meta.url);

/** 读取仓库里保存的快照；文件不存在时返回空字符串。 */
export function savedSnapshot() {
  try {
    return readFileSync(SNAPSHOT_FILE, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 比较两份快照。一致时返回空数组；不一致时返回便于阅读的说明：
 * 先指出第一处不同的行号和上下文，再列出只在一边出现的行（最多 limit 行）。
 */
export function snapshotDiff(expected, actual, limit = 40) {
  if (expected === actual) return [];
  const a = expected.split('\n'),
    b = actual.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const report = [
    `第 ${i + 1} 行开始不同（- 是保存的快照，+ 是当前迁移的结果）：`,
    ...a.slice(Math.max(0, i - 2), i).map((l) => '  ' + l),
    ...a.slice(i, i + 3).map((l) => '- ' + l),
    ...b.slice(i, i + 3).map((l) => '+ ' + l)
  ];
  const countA = new Map(),
    countB = new Map();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  for (const l of b) countB.set(l, (countB.get(l) ?? 0) + 1);
  const only = [];
  for (const [l, n] of countA) if (n > (countB.get(l) ?? 0)) only.push('- ' + l);
  for (const [l, n] of countB) if (n > (countA.get(l) ?? 0)) only.push('+ ' + l);
  if (only.length) report.push('', '只在一边出现的行：', ...only.slice(0, limit));
  else report.push('', '（行的内容相同，只是顺序不同）');
  if (only.length > limit) report.push(`……另有 ${only.length - limit} 行未列出`);
  return report;
}
