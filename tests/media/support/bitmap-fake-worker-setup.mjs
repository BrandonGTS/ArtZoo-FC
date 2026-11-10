import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:worker_threads' && /\/bitmap-runtime\.(ts|js)$/.test(context.parentURL ?? ''))
      return { url: new URL('./bitmap-fake-worker.mjs', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }
});
