import { resolveRequestSource } from '../auth/request-source';
import { failure, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { readActivityBody } from './http';
import { ActivityPenaltyAppealService } from './penalty-appeals';
export async function handlePenaltyAppeals(
  request: Request,
  action: 'mine' | 'submit' | 'list' | 'decide',
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
    const service = new ActivityPenaltyAppealService(auth);
    if (action === 'mine') return success(await service.minePenalties(new URL(request.url), token));
    if (action === 'list') return success(await service.appeals(new URL(request.url), token));
    const input = body ?? (await readActivityBody(request));
    return success(
      action === 'submit' ? await service.appeal(id, input, token) : await service.decide(id, input, token)
    );
  } catch (error) {
    return failure(error, 'activities/penalty-appeals-http');
  }
}
