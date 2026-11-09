import { handleQqBinding } from '../../../../../server/qq-official/http';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleQqBinding(request, 'cancel');
}
