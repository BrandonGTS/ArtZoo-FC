import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { AccountLifecycleService } from './service';
export async function handleAccountLifecycle(
  request: Request,
  action: 'accounts' | 'preview' | 'change' | 'audits',
  id = ''
) {
  try {
    const auth = getAccountService(),
      token = await sessionToken(),
      service = new AccountLifecycleService(auth);
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (action === 'accounts') return success(await service.accounts(url, token));
      if (action === 'audits') return success(await service.audits(url, token));
      if (action === 'preview') return success(await service.preview(id, url, token));
    }
    if (request.method !== 'PATCH' || action !== 'change')
      throw new AccountError('NOT_FOUND', '接口不存在', 404);
    validateOrigin(request);
    const body = await readBody(request),
      actor = await auth.requireAccount(auth.db, token, true);
    if (actor.account.adminRole !== 'SUPER_ADMIN')
      throw new AccountError('FORBIDDEN', '仅超级管理员可以执行此操作', 403);
    await auth.limitWriteSource(resolveRequestSource(request), token);
    return success(await service.change(id, body, token));
  } catch (error) {
    return failure(error, 'account-lifecycle/http');
  }
}
