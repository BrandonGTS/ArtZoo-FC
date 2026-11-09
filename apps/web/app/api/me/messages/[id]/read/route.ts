import { handleMessages } from '../../../../../../server/messages/http';
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  handleMessages(request, 'read', (await params).id);
