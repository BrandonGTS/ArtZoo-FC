import MessageCenter from '../../../../../components/messages/message-center';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function MessagesPage() {
  await requirePageAccount('/me/messages');
  return <MessageCenter />;
}
