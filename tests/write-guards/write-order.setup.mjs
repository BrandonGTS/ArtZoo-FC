// 仅 write-order.test.mjs 使用：用带计数器的替身，验证各写接口“先校验来源、再检查登录、最后计额度”的顺序。
import { registerHooks } from 'node:module';
const stub = new URL('./support/write-order-stubs.mjs', import.meta.url).href;
registerHooks({
  resolve(s, c, next) {
    if (
      s === '@artzoo/db' &&
      c.parentURL === new URL('../../apps/web/server/lottery/media-http.ts', import.meta.url).href
    )
      return {
        url: new URL('../../packages/db/src/media-lottery-mount.ts', import.meta.url).href,
        shortCircuit: true
      };
    if (s === '@artzoo/db/lottery-eligibility')
      return {
        url: new URL('../../packages/db/src/lottery-eligibility.ts', import.meta.url).href,
        shortCircuit: true
      };
    if (s === '@artzoo/media/photo-contract')
      return {
        url: new URL('../../packages/media/src/photo-contract.ts', import.meta.url).href,
        shortCircuit: true
      };
    if (s === 'next/headers') return { url: stub, shortCircuit: true };
    if (
      c.parentURL?.includes('/apps/web/server/') &&
      (s === './runtime' ||
        s === '../auth/runtime' ||
        s === './service' ||
        s === './series' ||
        s === './management' ||
        s === './ordinary-management' ||
        s === './attendance' ||
        s === './penalty-appeals' ||
        s === './image-runtime' ||
        s === '../media/photo-processor' ||
        (c.parentURL.endsWith('/lottery/media-http.ts') && s === './media'))
    )
      return { url: stub, shortCircuit: true };
    return next(s, c);
  }
});
