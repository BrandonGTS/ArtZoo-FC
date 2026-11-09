import { resolveRequestSource } from '../auth/request-source';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { ResourceService } from './service';
export async function handleResources(request: Request, category = false, id?: string) {
  try {
    const write = request.method !== 'GET';
    if (write) validateOrigin(request);
    const body = write ? await readBody(request) : undefined;
    const auth = getAccountService(),
      service = new ResourceService(auth);
    if (!write)
      return success(category ? await service.categories() : await service.list(new URL(request.url)));
    const token = await sessionToken();
    await auth.requireAccount(auth.db, token, true);
    await auth.limitWriteSource(resolveRequestSource(request), token);
    return success(await service.save(body!, token, id, category), id ? 200 : 201);
  } catch (error) {
    return failure(error, 'resources/http');
  }
}
