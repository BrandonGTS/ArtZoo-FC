import { handleGuestContact } from '../../../../server/guest-contact/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleGuestContact(request, 'list');
}
