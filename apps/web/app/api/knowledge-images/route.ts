import { handleKnowledgeImage } from '../../../server/knowledge/image-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleKnowledgeImage(request);
}
