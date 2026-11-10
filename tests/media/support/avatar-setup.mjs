import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = new URL('../../.././', import.meta.url);
const requireWeb = createRequire(new URL('apps/web/package.json', root));
const mapped = Object.fromEntries(
  ['sharp', 'next/server', 'next/headers'].map((x) => [x, new URL('file://' + requireWeb.resolve(x)).href])
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@artzoo/domain')
      return { url: new URL('packages/domain/src/index.ts', root).href, shortCircuit: true };
    if (specifier === '@artzoo/db') throw Error('Default database import forbidden in Phase 3 tests');
    if (specifier === 'sharp') return { url: mapped.sharp, shortCircuit: true };
    if (
      ((context.parentURL?.endsWith('/members/http.ts') ||
        context.parentURL?.endsWith('/media/http.ts') ||
        context.parentURL?.endsWith('/auth/http.ts')) &&
        specifier === '../auth/runtime') ||
      (context.parentURL?.endsWith('/auth/http.ts') && specifier === './runtime')
    )
      return { url: new URL('./avatar-runtime-stub.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
      const target = new URL(specifier, context.parentURL);
      for (const candidate of [target.href + '.ts', target.href.replace(/\.js$/, '.ts')])
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
    }
    if (specifier === 'next/server' || specifier === 'next/headers')
      return { url: mapped[specifier], shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        }).outputText
      };
    return next(url, context);
  }
});
