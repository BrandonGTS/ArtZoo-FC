import { handleAttendance } from '../../../../server/activities/attendance-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleAttendance(request, 'list');
}
