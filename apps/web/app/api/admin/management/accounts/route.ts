import { handleAdminManagement } from '../../../../../server/admin-management/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleAdminManagement(request, 'accounts');
}
