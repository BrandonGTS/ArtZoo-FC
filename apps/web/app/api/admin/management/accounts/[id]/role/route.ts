import { handleAdminManagement } from '../../../../../../../server/admin-management/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAdminManagement(request, 'role', (await context.params).id);
}
