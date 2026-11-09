import { handleKnowledge } from '../../../../../server/knowledge/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const p = await context.params;
  return handleKnowledge(request, 'read', p.id);
}
