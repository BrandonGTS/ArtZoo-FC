import { handleDaily } from '../../../server/daily/http';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return handleDaily(request, 'list');
}
export async function POST(request: Request) {
  return handleDaily(request, 'list');
}
