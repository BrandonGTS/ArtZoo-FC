import ContactAdmin from '../../../../../components/guest-contact/contact-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function ContactRequestsPage() {
  await requirePageAdministrator('/admin/contact-requests');
  return <ContactAdmin />;
}
