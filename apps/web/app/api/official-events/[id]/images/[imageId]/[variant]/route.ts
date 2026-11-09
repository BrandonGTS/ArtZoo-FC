import { failure, responseHeaders, sessionToken } from '../../../../../../../server/auth/http';
import { getAccountService } from '../../../../../../../server/auth/runtime';
import { OfficialEventService } from '../../../../../../../server/official-events/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; imageId: string; variant: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id, imageId, variant } = await context.params;
    const token = await sessionToken(),
      service = new OfficialEventService(getAccountService());
    const image = await service.image(id, imageId, variant, token);
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        ...responseHeaders,
        'Cache-Control': 'private, no-store',
        'Content-Type': image.mime,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Disposition': variant === 'original' ? 'attachment; filename="official-image"' : 'inline'
      }
    });
  } catch (error) {
    const response = failure(error, 'api/official-events/[id]/images/[imageId]/[variant]/route');
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return response;
  }
}
