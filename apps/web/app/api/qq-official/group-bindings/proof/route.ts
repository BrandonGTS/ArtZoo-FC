import { handleQqBridge } from '../../../../../server/qq-official/http';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return handleQqBridge(request, 'group-proof');
}
