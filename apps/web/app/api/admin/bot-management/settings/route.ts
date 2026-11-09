import { handleBotManagement } from '../../../../../server/bot-management/http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleBotManagement(request, 'settings');
}
