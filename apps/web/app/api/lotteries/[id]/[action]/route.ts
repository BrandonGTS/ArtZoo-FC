import { AccountError } from '@artzoo/domain';
import { failure } from '../../../../../server/auth/http';
import { handleLotteries } from '../../../../../server/lottery/http';
export async function POST(r: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (action !== 'join' && action !== 'leave' && action !== 'cancel' && action !== 'moderate')
    return failure(new AccountError('NOT_FOUND', '接口不存在', 404));
  return handleLotteries(r, action, id);
}
