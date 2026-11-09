import { handleDaily } from '../../../../../server/daily/http';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDaily(request, 'media', (await context.params).id);
}
