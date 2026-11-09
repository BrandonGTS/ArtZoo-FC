import AttendanceAppeals from '../../../../../components/activities/attendance-appeals';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export const dynamic = 'force-dynamic';
export default async function AttendanceAppealPage() {
  await requirePageAdministrator('/admin/attendance-appeals');
  return <AttendanceAppeals />;
}
