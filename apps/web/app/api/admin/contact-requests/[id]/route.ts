import { handleGuestContact } from '../../../../../server/guest-contact/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleGuestContact(request, 'process', (await context.params).id);
}
