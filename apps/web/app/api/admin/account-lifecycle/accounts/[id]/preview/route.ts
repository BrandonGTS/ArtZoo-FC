import { handleAccountLifecycle } from '../../../../../../../server/account-lifecycle/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAccountLifecycle(request, 'preview', (await context.params).id);
}
