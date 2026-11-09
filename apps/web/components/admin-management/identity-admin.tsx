'use client';
import { useState } from 'react';
import { AdminReturnLink } from '../admin-return-link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../page-heading';
import { CollectionTabs } from '../collection-controls';
import AccountManager from '../invitation/account-manager';
import InvitationManager from '../invitation/invitation-manager';
import RolesAdmin from './roles-admin';
import './admin-management.css';

export default function IdentityAdmin() {
  const { session, loading } = useAuthSession(),
    router = useRouter(),
    params = useSearchParams();
  const [locked, setLocked] = useState(false);
  const superAdmin = !loading && session?.user?.adminRole === 'SUPER_ADMIN';
  const requested = params.get('tab'),
    active =
      requested === 'invitations' ? requested : requested === 'roles' && superAdmin ? requested : 'accounts';
  return (
    <main className="home-content management-content identity-admin" id="main-content">
      <div className="management-heading">
        <PageHeading level={1} decoration="burger">
          身份与邀请
        </PageHeading>
        <AdminReturnLink disabled={locked} />
      </div>
      <CollectionTabs
        activeKey={active}
        disabled={locked}
        tabs={[
          { key: 'accounts', label: '身份维护' },
          ...(superAdmin ? [{ key: 'roles', label: '管理员资格' }] : []),
          { key: 'invitations', label: '邀请管理' }
        ]}
        onTabChange={(key) =>
          router.replace('/admin/accounts' + (key === 'accounts' ? '' : '?tab=' + key), { scroll: false })
        }
      />
      {active === 'roles' ? (
        <RolesAdmin embedded onLocked={setLocked} />
      ) : active === 'invitations' ? (
        <InvitationManager />
      ) : (
        <AccountManager onLocked={setLocked} />
      )}
    </main>
  );
}
