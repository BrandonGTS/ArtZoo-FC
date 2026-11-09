import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { ActivityService } from './service';
import { ActivitySeriesService } from './series';
import { ActivityManagementService } from './management';
import { OrdinaryActivityManagementService } from './ordinary-management';

export async function handleActivities(
  request: Request,
  action:
    | 'list'
    | 'history'
    | 'detail'
    | 'register'
    | 'move'
    | 'mine'
    | 'duties'
    | 'edit'
    | 'withdraw'
    | 'cancel'
    | 'continue'
    | 'series-confirm'
    | 'series-cancel-period'
    | 'ordinary-withdraw'
    | 'ordinary-move'
    | 'ordinary-cancel'
    | 'ordinary-reschedule'
    | 'ordinary-description'
    | 'ordinary-edit',
  id?: string
) {
  const receivedAt = new Date();
  try {
    const write = request.method === 'POST' || request.method === 'PATCH';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readActivityBody(request);
    }
    const token = await sessionToken(),
      auth = getAccountService();
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'series-confirm')
      return success(await new ActivitySeriesService(auth).confirm(id ?? '', body, token));
    if (action === 'series-cancel-period')
      return success(await new ActivitySeriesService(auth).cancelPeriod(id ?? '', body, token));
    if (action.startsWith('ordinary-'))
      return success(
        await new OrdinaryActivityManagementService(auth).execute(
          id ?? '',
          action.slice('ordinary-'.length),
          body,
          token
        )
      );
    const service = new ActivityService(auth);
    if (['edit', 'withdraw', 'cancel', 'continue'].includes(action)) {
      const management = new ActivityManagementService(auth);
      if (action === 'edit') return success(await management.edit(id ?? '', body, token));
      if (action === 'withdraw') return success(await management.withdraw(id ?? '', body, token));
      if (action === 'cancel') return success(await management.cancel(id ?? '', body, token));
      return success(await management.continueActivity(id ?? '', body, token));
    }
    if (action === 'duties') return success(await service.duties(new URL(request.url), token));
    if (action === 'mine') return success(await service.mine(token, new URL(request.url)));
    if (action === 'history') return success(await service.history(id ?? '', new URL(request.url), token));
    if (action === 'detail') return success(await service.detail(id ?? '', token));
    if (action === 'move') return success(await service.moveRegistration(id ?? '', body, token, receivedAt));
    if (action === 'register') return success(await service.register(id ?? '', body, token, receivedAt));
    if (write) {
      const result = await service.create(body, token);
      return success(result, result.replayed ? 200 : 201);
    }
    return success(await service.list(new URL(request.url), token));
  } catch (error) {
    return failure(error, 'activities/http');
  }
}

// The 200-seat / 2000-character contract fits this bounded activity-specific envelope.
export async function readActivityBody(request: Request): Promise<Record<string, unknown>> {
  const limit = 32768;
  if (Number(request.headers.get('content-length')) > limit)
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
    }
    chunks.push(chunk.value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccountError('VALIDATION_ERROR', '请求JSON格式无效', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new AccountError('VALIDATION_ERROR', '请求格式无效', 400);
  return body as Record<string, unknown>;
}
