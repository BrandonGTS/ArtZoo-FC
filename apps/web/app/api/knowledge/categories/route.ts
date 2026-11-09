import { handleKnowledge } from '../../../../server/knowledge/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleKnowledge(request, 'categories');
}
export function POST(request: Request) {
  return handleKnowledge(request, 'categories');
}
