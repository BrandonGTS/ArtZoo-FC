import { resolveRequestSource } from '../auth/request-source';
import { AccountError, siteHelpStepCommand } from '@artzoo/domain';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { SiteHelpProgressService } from './service';

// Optional injected ports keep adapter tests off real account data and cookies.
export async function handleHelpProgress(
  request: Request,
  ports?: { service: SiteHelpProgressService; token?: string | null }
) {
  try {
    if (!['GET', 'POST'].includes(request.method)) throw new AccountError('NOT_FOUND', '接口不存在', 404);
    if (new URL(request.url).searchParams.size)
      throw new AccountError('VALIDATION_ERROR', '帮助进度请求字段无效', 400);
    if (request.method === 'POST') validateOrigin(request);
    const body = request.method === 'POST' ? siteHelpStepCommand(await readBody(request)) : null;
    const token = ports ? ports.token : await sessionToken();
    const service = ports?.service ?? new SiteHelpProgressService(getAccountService()),
      auth = service.auth;
    if (body) {
      await auth.requireAccount(auth.db, token);
      await auth.limitWriteSource(resolveRequestSource(request), token);
      return success(await service.complete(body, token));
    }
    return success(await service.read(token));
  } catch (error) {
    return failure(error, 'site-help/http');
  }
}
