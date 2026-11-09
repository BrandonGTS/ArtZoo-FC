import { handleDaily } from '../../../../server/daily/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleDaily(request, 'upload');
}
