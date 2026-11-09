import { handleAttendance } from '../../../../../server/activities/attendance-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAttendance(request, 'read', (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAttendance(request, 'record', (await context.params).id);
}
