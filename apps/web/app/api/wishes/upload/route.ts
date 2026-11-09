import { handleWishes } from '../../../../server/wishes/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleWishes(request, 'upload');
}
