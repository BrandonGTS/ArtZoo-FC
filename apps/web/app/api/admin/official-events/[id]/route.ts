import { handleOfficialEvents } from '../../../../../server/official-events/http';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handleOfficialEvents(request, 'get', (await context.params).id);
}
export async function POST(request: Request, context: Context) {
  return handleOfficialEvents(request, 'mutate', (await context.params).id);
}
