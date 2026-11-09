import { resolveRequestSource } from '../auth/request-source';
import { failure, sessionToken, success, validateOrigin, readBody } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { OfficialEventService } from './service';
export async function handleOfficialEvents(
  request: Request,
  action: 'list' | 'get' | 'mutate' | 'calendar' | 'sync',
  id = ''
) {
  try {
    const write = request.method === 'POST';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readBody(request);
    }
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new OfficialEventService(auth);
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'list') return success(await service.list(new URL(request.url), token));
    if (action === 'get') return success(await service.get(id, new URL(request.url), token));
    if (action === 'calendar') return success(await service.calendar(new URL(request.url), token));
    if (action === 'sync') return success(await service.sync(body, token));
    return success(await service.mutate(id, body, token));
  } catch (error) {
    return failure(error, 'official-events/http');
  }
}
