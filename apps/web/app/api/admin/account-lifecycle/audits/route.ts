import { handleAccountLifecycle } from '../../../../../server/account-lifecycle/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return handleAccountLifecycle(request, 'audits');
}
