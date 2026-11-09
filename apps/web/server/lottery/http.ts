import { resolveRequestSource } from '../auth/request-source';
import { failure, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { readActivityBody } from '../activities/http';
import { LotteryService, type LotteryPorts } from './service';
import { databaseLotteryPorts } from '@artzoo/db';
import { countCheckinMonth } from '../checkin/service';
// Integrator binds current check-in/lifecycle policy plus durable drawEligibilityAt(T). Missing T facts must not draw. No live send transport.
let ports: LotteryPorts = { ...databaseLotteryPorts(), countMonth: countCheckinMonth };
export function configureLotteryPorts(value: LotteryPorts) {
  ports = value;
}
export async function handleLotteries(
  request: Request,
  action: 'list' | 'get' | 'create' | 'join' | 'leave' | 'cancel' | 'moderate',
  id = ''
) {
  try {
    const write = request.method === 'POST';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readActivityBody(request);
    }
    const auth = getAccountService(),
      token = await sessionToken(),
      service = new LotteryService(auth, ports);
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'list')
      return success(
        await service.list(
          token,
          new URL(request.url).searchParams.get('page') ?? 1,
          new URL(request.url).searchParams.get('category') ?? 'all',
          new URL(request.url).searchParams.get('search') ?? ''
        )
      );
    if (action === 'get') return success(await service.get(id, token));
    if (action === 'create') {
      const result = await service.create(body, token);
      return success(result, result.replayed ? 200 : 201);
    }
    if (action === 'moderate') return success(await service.moderate(id, body, token));
    return success(await service.change(id, action, body, token));
  } catch (error) {
    return failure(error, 'lottery/http');
  }
}
