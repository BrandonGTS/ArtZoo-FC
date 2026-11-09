import { handleKnowledge } from '../../../../server/knowledge/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const p = await context.params;
  return handleKnowledge(request, 'detail', p.id);
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const p = await context.params;
  return handleKnowledge(request, 'detail', p.id);
}
