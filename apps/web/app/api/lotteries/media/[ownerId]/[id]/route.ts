import { readLotteryImage } from '../../../../../../server/lottery/media-http';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ownerId: string; id: string }> }
) {
  const { ownerId, id } = await params;
  return readLotteryImage(request, ownerId, id);
}
