import { handleMessages } from '../../../../server/messages/http';
export const GET = (request: Request) => handleMessages(request, 'list');
