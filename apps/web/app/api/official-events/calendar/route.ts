import { handleOfficialEvents } from '../../../../server/official-events/http';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleOfficialEvents(request, 'calendar');
