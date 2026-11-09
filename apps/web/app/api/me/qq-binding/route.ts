import { handleQqBinding } from '../../../../server/qq-official/http';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return handleQqBinding(request, 'status');
}
