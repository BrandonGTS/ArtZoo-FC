import { handleGuestContact } from '../../../server/guest-contact/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleGuestContact(request, 'submit');
}
