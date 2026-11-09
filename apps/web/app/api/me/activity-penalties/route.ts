import { handlePenaltyAppeals } from '../../../../server/activities/penalty-appeals-http';
export const GET = (request: Request) => handlePenaltyAppeals(request, 'mine');
