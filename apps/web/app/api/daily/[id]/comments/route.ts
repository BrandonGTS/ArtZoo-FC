import { handleDaily } from '../../../../../server/daily/http';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDaily(request, 'comments', (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDaily(request, 'comments', (await context.params).id);
}
