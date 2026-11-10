import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = new URL('../../.././', import.meta.url);
registerHooks({
  resolve(s, c, next) {
    if (
      process.env.REV_WORKER_SCENARIO &&
      ['@artzoo/domain', '@artzoo/db', '@artzoo/media/official'].includes(s)
    )
      return { url: new URL('./worker-stub.mjs', import.meta.url).href, shortCircuit: true };
    if (s === '@artzoo/domain')
      return { url: new URL('packages/domain/src/index.ts', root).href, shortCircuit: true };
    if (s.startsWith('.') && c.parentURL?.endsWith('.ts')) {
      const target = new URL(s, c.parentURL);
      for (const url of [target.href + '.ts', target.href.replace(/\.js$/, '.ts')])
        if (existsSync(fileURLToPath(url))) return { url, shortCircuit: true };
    }
    return next(s, c);
  },
  load(url, c, next) {
    if (url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        }).outputText
      };
    return next(url, c);
  }
});
