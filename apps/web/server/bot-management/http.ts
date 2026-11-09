import { resolveRequestSource } from '../auth/request-source';
import { BotGroupService } from './groups';
import { AccountError } from '@artzoo/domain';
import { loadQqOfficialConfig } from '@artzoo/db';
import { getAccountService } from '../auth/runtime';
import { failure, success, sessionToken, validateOrigin, readBody } from '../auth/http';
import { BotManagementService } from './service';
export async function handleBotManagement(
  request: Request,
  action:
    | 'groups'
    | 'group-initiate'
    | 'group-select'
    | 'group-progress'
    | 'group-confirm'
    | 'group-toggle'
    | 'test-status'
    | 'settings'
    | 'overview'
    | 'draft'
    | 'preview'
    | 'publish'
    | 'test'
    | 'save'
) {
  try {
    const auth = getAccountService(),
      token = await sessionToken(),
      service = new BotManagementService(auth, loadQqOfficialConfig());
    await service.requireSuper(auth.db, token);
    if (action === 'groups' && request.method === 'GET')
      return success(await new BotGroupService(auth, service.config).list(token));
    if (request.method === 'GET' && action === 'test-status')
      return success(await service.testStatus(new URL(request.url).searchParams.get('id'), token));
    if (request.method === 'GET' && action === 'settings') return success(await service.settings(token));
    if (request.method === 'GET' && action === 'overview') return success(await service.snapshot(token));
    if (
      request.method !== 'POST' ||
      action === 'overview' ||
      action === 'settings' ||
      action === 'test-status' ||
      action === 'groups'
    )
      throw new AccountError('NOT_FOUND', '接口不存在', 404);
    validateOrigin(request);
    const body = await readBody(request);
    await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action.startsWith('group-'))
      return success(
        await new BotGroupService(auth, service.config).command(
          action.slice(6) as 'initiate' | 'select' | 'progress' | 'confirm' | 'toggle',
          body,
          token
        )
      );
    return success(
      action === 'preview'
        ? await service.preview(body, token)
        : await service.command(action as 'draft' | 'publish' | 'test' | 'save', body, token)
    );
  } catch (error) {
    return failure(error, 'bot-management/http');
  }
}
