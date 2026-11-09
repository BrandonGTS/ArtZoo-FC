import { handleAttendance } from '../../../../../../server/activities/attendance-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAttendance(request, 'appeal', (await context.params).id);
}
