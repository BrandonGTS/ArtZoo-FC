import { handle } from '../../../../server/auth/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  return handle(request, 'invitation', (await context.params).token);
}
