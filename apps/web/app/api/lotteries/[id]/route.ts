import { handleLotteries } from '../../../../server/lottery/http';
export const dynamic = 'force-dynamic';
export async function GET(r: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleLotteries(r, 'get', (await params).id);
}
