import { AdminReturnLink } from '../../../../../components/admin-return-link';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAdministrator('/admin/knowledge-categories');
  return (
    <main className="home-content" id="main-content">
      <div className="admin-return-heading">
        <h1>固定配置由开发维护</h1>
        <AdminReturnLink />
      </div>
    </main>
  );
}
