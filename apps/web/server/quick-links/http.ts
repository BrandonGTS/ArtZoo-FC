import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { QuickLinkService } from './service';
export async function handleQuickLinks(request: Request, admin = false) {
  try {
    if (request.method !== 'GET') {
      if (!admin || request.method !== 'POST') throw new AccountError('NOT_FOUND', '接口不存在', 404);
      validateOrigin(request);
    }
    const body = request.method === 'POST' ? await readBody(request) : null;
    const token = admin ? await sessionToken() : null,
      auth = getAccountService(),
      service = new QuickLinkService(auth);
    if (request.method === 'GET') return success(await service.list(new URL(request.url), token, admin));
    await auth.requireAccount(auth.db, token, true);
    await auth.limitWriteSource(resolveRequestSource(request), token);
    return success(await service.mutate(body!, token));
  } catch (error) {
    return failure(error, 'quick-links/http');
  }
}
export async function handleQuickLinkIcon(request: Request, id: string) {
  try {
    const bytes = await new QuickLinkService(getAccountService()).icon(
      id,
      new URL(request.url).searchParams.get('v')
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer'
      }
    });
  } catch (error) {
    return failure(error, 'quick-links/http');
  }
}
