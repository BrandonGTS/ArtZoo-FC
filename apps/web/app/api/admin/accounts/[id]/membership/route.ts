import { handle } from '../../../../../../server/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, 'membership', (await context.params).id);
}
