import { resolveRequestSource } from '../../../../server/auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, sessionToken, success } from '../../../../server/auth/http';
import { getAccountService } from '../../../../server/auth/runtime';
import { readAvatarBody, validateAvatarOrigin } from '../../../../server/media/http';
import { withAvatarUploadSlot } from '../../../../server/media/processor';
import { AvatarService } from '../../../../server/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    validateAvatarOrigin(request);
    const token = await sessionToken();
    if (!token) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    const auth = getAccountService();
    const service = new AvatarService(auth);
    const accountId = await service.authorizeUpload(token);
    await auth.checkWriteSource(resolveRequestSource(request), token);
    await auth.limitWriteParsing(resolveRequestSource(request), accountId);
    return await withAvatarUploadSlot(async () => {
      const body = await readAvatarBody(request);
      await auth.limitWriteSource(resolveRequestSource(request), token);
      return success(await service.upload(token, accountId, body.input, body.crop, body.revision));
    });
  } catch (error) {
    return failure(error, 'api/me/avatar/route');
  }
}
