import { handleQqBridge } from '../../../../../server/qq-official/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleQqBridge(request, 'begin');
}
