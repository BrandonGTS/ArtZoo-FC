// tests/auth 的替身：auth/http.ts 里的 ./runtime 会连接真实数据库，测试中换成可注入的替身。
import { registerHooks } from 'node:module';
const http = new URL('../../apps/web/server/auth/http.ts', import.meta.url).href;
const runtimeStub = new URL('./support/runtime-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === http && specifier === './runtime')
      return { url: runtimeStub, shortCircuit: true };
    return next(specifier, context);
  }
});
