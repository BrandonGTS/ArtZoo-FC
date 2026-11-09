import { resolveRequestSource } from '../auth/request-source';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { GuestContactService } from './service';

export async function handleGuestContact(request: Request, action: 'submit' | 'list' | 'process', id = '') {
  try {
    // Reject invalid source/JSON before consuming any legitimate write quota.
    let body: Record<string, unknown> = {};
    if (request.method !== 'GET') {
      validateOrigin(request);
      body = await readBody(request);
    }
    const auth = getAccountService();
    const service = new GuestContactService(auth);
    const token = await sessionToken();
    if (request.method !== 'GET') await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'submit') return success(await service.submit(body), 201);
    if (action === 'list') return success(await service.list(new URL(request.url), token));
    return success(await service.process(id, body, token));
  } catch (error) {
    return failure(error, 'guest-contact/http');
  }
}
