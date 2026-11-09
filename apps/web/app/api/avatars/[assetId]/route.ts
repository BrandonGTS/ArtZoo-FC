import { AccountError } from '@artzoo/domain';
import { failure, responseHeaders, sessionToken } from '../../../../server/auth/http';
import { getAccountService } from '../../../../server/auth/runtime';
import { AvatarService } from '../../../../server/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const url = new URL(request.url),
      size = url.searchParams.get('size');
    if (
      [...url.searchParams.keys()].some((key) => key !== 'size') ||
      url.searchParams.getAll('size').length > 1 ||
      (size !== null && size !== 'small' && size !== 'full')
    )
      throw new AccountError('VALIDATION_ERROR', '头像尺寸无效', 400);
    const token = await sessionToken();
    if (!token) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    const { assetId } = await context.params;
    const data = await new AvatarService(getAccountService()).read(
      token,
      assetId,
      size === 'small' ? 'small' : 'full'
    );
    return new Response(new Uint8Array(data), {
      headers: {
        ...responseHeaders,
        'Content-Type': 'image/webp',
        'Content-Length': String(data.length),
        'Cross-Origin-Resource-Policy': 'same-origin',
        Vary: 'Cookie'
      }
    });
  } catch (error) {
    return failure(error, 'api/avatars/[assetId]/route');
  }
}
