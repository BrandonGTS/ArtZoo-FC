import { handleQqBridge } from '../../../../../server/qq-official/http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleQqBridge(request, 'test-ack');
}
