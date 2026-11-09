import { resolveRequestSource } from '../auth/request-source';
import { teamPage } from '@artzoo/domain';
import { failure, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { readActivityBody } from '../activities/http';
import { TeamService } from './service';
export type TeamAction =
  | 'list'
  | 'mine'
  | 'get'
  | 'create'
  | 'apply'
  | 'decide'
  | 'edit'
  | 'withdrawApplication'
  | 'addMember'
  | 'propose'
  | 'proposeBatch'
  | 'editSession'
  | 'feedback'
  | 'confirm'
  | 'cancelSession'
  | 'leave'
  | 'removeMember'
  | 'dissolve'
  | 'completeRecruitment'
  | 'deleteRecruitment'
  | 'recordLeave'
  | 'substitute'
  | 'recordParticipation'
  | 'history';
export async function handleTeams(request: Request, action: TeamAction, id = '') {
  try {
    const write = request.method === 'POST';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readActivityBody(request);
    }
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new TeamService(auth);
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'list' || action === 'mine')
      return success(
        await service.list(action === 'mine', token, teamPage(new URL(request.url).searchParams.get('page')))
      );
    if (action === 'history') {
      const query = new URL(request.url).searchParams;
      return success(
        query.get('pagination') === '1'
          ? await service.history(token, query.get('page'))
          : await service.history(token)
      );
    }
    if (action === 'get') return success(await service.get(id, token));
    if (action === 'create') {
      const result = await service.create(body, token);
      return success(result, result.replayed ? 200 : 201);
    }
    return success(await service[action](id, body, token));
  } catch (error) {
    return failure(error, 'teams/http');
  }
}
