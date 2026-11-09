import { resolveRequestSource } from '../auth/request-source';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { MemberService } from './service';

export async function handleMembers(request: Request, action: 'own' | 'list' | 'member', id?: string) {
  try {
    const write = action === 'own' && request.method === 'PATCH';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readBody(request);
    }
    const token = await sessionToken();
    const auth = getAccountService();
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    const service = new MemberService(auth);
    if (action === 'own')
      return success(write ? await service.updateOwn(body, token) : await service.getOwn(token));
    if (action === 'list') return success(await service.list(new URL(request.url), token));
    return success(await service.getMember(id ?? '', token));
  } catch (error) {
    return failure(error, 'members/http');
  }
}
