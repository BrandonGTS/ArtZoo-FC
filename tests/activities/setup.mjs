// tests/activities 的替身。下列测试文件不使用替身：
//   数据库测试 *.pg.test.mjs（直接连真实测试库），以及只测发布表单和长期活动纯逻辑的几个文件。
//   @artzoo/db         → support/db-stub.mjs：只暴露纯逻辑函数，getDatabase() 一律报错；
//   next/headers、auth 的 runtime → support/runtime-stub.mjs：由测试注入账号服务和 cookie。
import { registerHooks } from 'node:module';
const REAL = [
  '.pg.test.mjs',
  '/publishing-description.test.mjs',
  '/publishing-followup.test.mjs',
  '/publishing-service.test.mjs',
  '/offline-series-contract.test.mjs',
  '/offline-series-service.test.mjs',
  '/series-period-cancellation.test.mjs',
  '/series-maintenance.test.mjs'
];
const usesRealModules = process.argv.some((arg) => REAL.some((suffix) => arg.endsWith(suffix)));
const dbStub = new URL('./support/db-stub.mjs', import.meta.url).href;
const runtimeStub = new URL('./support/runtime-stub.mjs', import.meta.url).href;
if (!usesRealModules)
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
