import { handle } from '../../../../server/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handle(request, 'login');
}
