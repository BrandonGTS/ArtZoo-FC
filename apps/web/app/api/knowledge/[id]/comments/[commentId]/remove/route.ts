import { handleKnowledge } from '../../../../../../../server/knowledge/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> }
) {
  const p = await context.params;
  return handleKnowledge(request, 'remove-comment', p.id, p.commentId);
}
