import { handleWishes } from '../../../../server/wishes/http';
export const GET = (request: Request) => handleWishes(request, 'home');
