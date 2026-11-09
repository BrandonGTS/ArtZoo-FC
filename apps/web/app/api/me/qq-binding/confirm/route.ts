import { handleQqBinding } from '../../../../../server/qq-official/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleQqBinding(request, 'confirm');
}
