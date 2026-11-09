import { resolveRequestSource } from '../auth/request-source';
import { failure, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { readActivityBody } from './http';
import { ActivityAttendanceService } from './attendance';
export async function handleAttendance(
  request: Request,
  action: 'read' | 'record' | 'appeal' | 'list' | 'decide',
  id = ''
) {
  try {
    const write = request.method === 'POST';
    if (write) validateOrigin(request);
    const token = await sessionToken(),
      auth = getAccountService();
    let body: Record<string, unknown> | undefined;
    if (write) {
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      body = await readActivityBody(request);
      await auth.limitWriteSource(resolveRequestSource(request), token);
    }
    const service = new ActivityAttendanceService(auth);
    if (action === 'read') return success(await service.attendance(id, token));
    if (action === 'list') return success(await service.appeals(new URL(request.url), token));
    const input = body ?? (await readActivityBody(request));
    if (action === 'record') return success(await service.record(id, input, token));
    if (action === 'appeal') return success(await service.appeal(id, input, token));
    return success(await service.decide(id, input, token));
  } catch (error) {
    return failure(error, 'activities/attendance-http');
  }
}
