import { handleKnowledgeImage } from '../../../../server/knowledge/image-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleKnowledgeImage(request, (await context.params).id);
}
