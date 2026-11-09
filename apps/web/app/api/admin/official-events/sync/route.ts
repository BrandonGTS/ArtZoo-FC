import { handleOfficialEvents } from '../../../../../server/official-events/http';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleOfficialEvents(request, 'sync');
