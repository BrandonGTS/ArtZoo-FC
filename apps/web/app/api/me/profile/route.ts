import { handleMembers } from '../../../../server/members/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleMembers(request, 'own');
}
export function PATCH(request: Request) {
  return handleMembers(request, 'own');
}
