import { handleWishes } from '../../../server/wishes/http';
export const GET = (request: Request) => handleWishes(request, 'list');
export const POST = (request: Request) => handleWishes(request, 'create');
