// pool-health 测试的替身：pg、@prisma/adapter-pg 与生成的 Prisma 客户端换成 support/pool-stubs.mjs。
import { registerHooks } from 'node:module';
const root = new URL('../../../', import.meta.url);
const stub = new URL('./pool-stubs.mjs', import.meta.url).href;
registerHooks({
  resolve(s, c, next) {
    if (s === '@artzoo/db' && c.parentURL?.endsWith('/api/health/route.ts'))
      return { url: stub, shortCircuit: true };
    if (
      c.parentURL === new URL('packages/db/src/pool-health.ts', root).href &&
      s === './connection-timezone.js'
    )
      return { url: new URL('packages/db/src/connection-timezone.ts', root).href, shortCircuit: true };
    if (c.parentURL === new URL('packages/db/src/index.ts', root).href) {
      if (s === 'pg' || s === '@prisma/adapter-pg' || s.includes('generated/prisma/client.js'))
        return { url: stub, shortCircuit: true };
      if (s === './pool-health.js')
        return { url: new URL('packages/db/src/pool-health.ts', root).href, shortCircuit: true };
      if (s === './lottery-entry-insert.js')
        return { url: new URL('packages/db/src/lottery-entry-insert.ts', root).href, shortCircuit: true };
    }
    return next(s, c);
  }
});
