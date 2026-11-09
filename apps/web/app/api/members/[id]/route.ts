import { handleMembers } from '../../../../server/members/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleMembers(request, 'member', (await context.params).id);
}
