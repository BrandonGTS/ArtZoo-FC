// Narrow CLI-only source loader using the already pinned TypeScript dependency.
// No test mocks, package aliases, configuration files or environment loading.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
const root = new URL('../apps/web/server/auth/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root)) {
      const target = new URL(specifier, context.parentURL);
      if (target.href.startsWith(root) && !/\.[a-z]+$/i.test(target.pathname)) {
        const candidate = new URL(target.href + '.ts');
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        }).outputText
      };
    }
    return next(url, context);
  }
});
