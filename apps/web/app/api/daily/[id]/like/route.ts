import { handleDaily } from '../../../../../server/daily/http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDaily(request, 'like', (await context.params).id);
}
