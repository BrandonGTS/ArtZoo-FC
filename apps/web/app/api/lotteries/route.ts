import { handleLotteries } from '../../../server/lottery/http';
export const dynamic = 'force-dynamic';
export const GET = (r: Request) => handleLotteries(r, 'list');
export const POST = (r: Request) => handleLotteries(r, 'create');
