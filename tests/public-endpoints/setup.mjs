// tests/public-endpoints 的替身：访客留言和头像接口背后的服务、数据库换成替身。
import { registerHooks } from 'node:module';
const stub = new URL('./support/stubs.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? '';
    if (specifier === '@artzoo/db')
      throw new Error('Database imports forbidden in additional HTTP adapter tests');
    if (
      specifier === 'next/headers' ||
      specifier.endsWith('/auth/runtime') ||
      (parent.endsWith('/auth/http.ts') && specifier === './runtime') ||
      (parent.endsWith('/guest-contact/http.ts') && specifier === './service') ||
      (parent.endsWith('/api/me/avatar/route.ts') && specifier.endsWith('/media/service'))
    ) {
      return { url: stub, shortCircuit: true };
    }
    return next(specifier, context);
  }
});
