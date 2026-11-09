import { resolveRequestSource } from '../auth/request-source';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { CheckinService } from './service';
export async function handleCheckin(request: Request) {
  try {
    const write = request.method === 'POST';
    if (write) validateOrigin(request);
    const body = write ? await readBody(request) : undefined;
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new CheckinService(auth);
    if (write) {
      await auth.requireAccount(auth.db, token);
      await auth.limitWriteSource(resolveRequestSource(request), token);
    }
    return success(
      write
        ? await service.submit(body!, token)
        : await service.read(token, new URL(request.url).searchParams.get('month'))
    );
  } catch (error) {
    return failure(error, 'checkin/http');
  }
}
