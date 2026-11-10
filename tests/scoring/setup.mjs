// tests/scoring 的替身：@artzoo/db 换成只暴露纯逻辑函数的 support/db-stub.mjs（getDatabase() 一律报错），
// next/headers 与 auth 的 runtime 换成 support/runtime-stub.mjs（由测试注入账号服务）。
import { registerHooks } from 'node:module';
const dbStub = new URL('./support/db-stub.mjs', import.meta.url).href;
const runtimeStub = new URL('./support/runtime-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@artzoo/db') return { url: dbStub, shortCircuit: true };
    if (specifier === 'next/headers') return { url: runtimeStub, shortCircuit: true };
    if (
      (specifier === '../auth/runtime' && context.parentURL?.includes('/server/')) ||
      (specifier === './runtime' && context.parentURL?.endsWith('/auth/http.ts'))
    )
      return { url: runtimeStub, shortCircuit: true };
    return next(specifier, context);
  }
});
