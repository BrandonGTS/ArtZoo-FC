import { resolveRequestSource } from '../auth/request-source';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { MessageService } from './service';
export async function handleMessages(
  request: Request,
  action: 'list' | 'unread' | 'preview' | 'read' | 'delete',
  id = ''
) {
  try {
    let body: Record<string, unknown> = {};
    if (action === 'read' || action === 'delete') {
      validateOrigin(request);
      body = await readBody(request);
    }
    const auth = getAccountService(),
      token = await sessionToken();
    if (action === 'read' || action === 'delete')
      await auth.limitWriteSource(resolveRequestSource(request), token);
    const service = new MessageService(auth);
    return success(
      action === 'list'
        ? await service.inbox(new URL(request.url), token)
        : action === 'unread'
          ? await service.unread(token)
          : action === 'preview'
            ? await service.preview(token)
            : action === 'delete'
              ? await service.remove(id, body, token)
              : await service.markRead(id, body, token)
    );
  } catch (error) {
    return failure(error, 'messages/http');
  }
}
