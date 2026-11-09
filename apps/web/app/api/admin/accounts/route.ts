import { handle } from '../../../../server/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handle(request, 'accounts');
}
