import { handleAnnouncements } from '../../../../../server/announcements/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function PATCH(request: Request) {
  return handleAnnouncements(request, 'selection');
}
