import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const root = new URL('../../../packages/media/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root) && specifier === './photo-original-reencode.js')
      return {
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export async function reencodeOriginal(){if(globalThis.syntheticOriginalDelay)await new Promise(r=>setTimeout(r,globalThis.syntheticOriginalDelay));return Buffer.alloc(globalThis.syntheticOriginalBytes??8);}'
          ),
        shortCircuit: true
      };
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  }
});
