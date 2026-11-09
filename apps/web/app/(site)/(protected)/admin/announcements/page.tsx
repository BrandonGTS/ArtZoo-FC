import AnnouncementAdmin from '../../../../../components/announcements/announcement-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function AnnouncementsPage() {
  await requirePageAdministrator('/admin/announcements');
  return <AnnouncementAdmin />;
}
