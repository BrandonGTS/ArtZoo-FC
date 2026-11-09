import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { AnnouncementService } from './service';
export async function handleAnnouncements(
  request: Request,
  action: 'active' | 'list' | 'publish' | 'selection' | 'delete',
  id = ''
) {
  try {
    let body: Record<string, unknown> = {};
    if (request.method !== 'GET') {
      validateOrigin(request);
      body = await readBody(request);
    }
    const service = new AnnouncementService(getAccountService());
    if (action === 'active') return success(await service.active());
    const token = await sessionToken();
    if (action === 'list') return success(await service.list(new URL(request.url), token));
    if (action === 'publish') return success(await service.publish(body, token), 201);
    if (action === 'delete') return success(await service.remove(id, body, token));
    return success(await service.select(body, token));
  } catch (error) {
    return failure(error, 'announcements/http');
  }
}
