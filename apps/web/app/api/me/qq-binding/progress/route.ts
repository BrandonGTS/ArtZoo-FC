import { handleQqBinding } from '../../../../../server/qq-official/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleQqBinding(request, 'progress');
}
