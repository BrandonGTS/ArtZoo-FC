import { handle } from '../../../../../../server/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, 'remove-invitation', (await context.params).id);
}
