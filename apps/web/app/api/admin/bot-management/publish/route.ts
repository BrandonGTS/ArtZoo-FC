import { handleBotManagement } from '../../../../../server/bot-management/http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleBotManagement(request, 'publish');
}
