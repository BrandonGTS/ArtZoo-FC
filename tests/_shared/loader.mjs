// 所有测试共用的加载器：让 Node 直接运行仓库里的 TypeScript 源码。
// 只做通用的事：
//   1. .ts 文件转译成 JavaScript；
//   2. 不带扩展名或写成 .js 的相对导入，解析到同名 .ts 文件；
//   3. @artzoo/domain、@artzoo/media 等工作区包指向源码；next/* 指向 apps/web 安装的版本；
//   4. @artzoo/db 及其子模块也指向源码。导入本身不会连接数据库；
//      单元测试里一旦真的发起连接，会被 no-network.mjs 拦下。需要替身时在 setup.mjs 中替换。
// 某个目录需要额外替身时，在该目录放 setup.mjs，用 registerHooks 追加规则（后注册的先生效）。
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const webRequire = createRequire(new URL('apps/web/package.json', root));
// 必须在注册钩子之前解析好，否则 require.resolve 会再次进入钩子造成无限递归。
const NEXT = Object.fromEntries(
  ['next/headers', 'next/server', 'next/navigation', 'next/cache'].map((s) => [
    s,
    new URL('file://' + webRequire.resolve(s)).href
  ])
);

function sourceFile(pkg, sub) {
  const base = new URL(`packages/${pkg}/src/${sub ?? 'index'}`, root);
  for (const candidate of [base.href + '.ts', base.href.replace(/\.js$/, '.ts'), base.href])
    if (existsSync(fileURLToPath(candidate))) return candidate;
  return null;
}

registerHooks({
  resolve(specifier, context, next) {
    const workspace = /^@artzoo\/(domain|media|db)(?:\/(.+))?$/.exec(specifier);
    if (workspace) {
      const url = sourceFile(workspace[1], workspace[2]);
      if (url) return { url, shortCircuit: true };
    }
    if (NEXT[specifier]) return { url: NEXT[specifier], shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
      const target = new URL(specifier, context.parentURL);
      for (const candidate of [
        target.href + '.ts',
        target.href.replace(/\.js$/, '.ts'),
        target.href + '/index.ts'
      ])
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') || url.endsWith('.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          fileName: fileURLToPath(url),
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX
          }
        }).outputText
      };
    return next(url, context);
  }
});
