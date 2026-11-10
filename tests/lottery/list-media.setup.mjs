import { registerHooks } from 'node:module';
const storage = new URL('../../packages/media/src/cos-routed-storage.ts', import.meta.url).href;
const stub = new URL('./support/empty-cos-db.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@artzoo/db' && context.parentURL === storage) return { url: stub, shortCircuit: true };
    return next(specifier, context);
  }
});
