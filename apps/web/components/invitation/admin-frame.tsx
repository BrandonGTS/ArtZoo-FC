'use client';
import { AdminReturnLink } from '../admin-return-link';
import { useRouter } from 'next/navigation';
import { PageHeading } from '../home-content';
import { AccountTheme } from '../account/account-ui';
import { CollectionTabs } from '../collection-controls';
import styles from './admin.module.css';
export default function AdminFrame({
  active,
  children
}: {
  active: 'invitations' | 'accounts';
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <AccountTheme>
      <main id="main-content" className={styles.main}>
        <div className={styles.heading}>
          <PageHeading level={1} decoration="burger">
            身份与邀请
          </PageHeading>
          <AdminReturnLink />
        </div>
        <CollectionTabs
          activeKey={active}
          tabs={[
            { key: 'accounts', label: '身份维护' },
            { key: 'invitations', label: '邀请管理' }
          ]}
          onTabChange={(key) =>
            router.push('/admin/accounts' + (key === 'invitations' ? '?tab=invitations' : ''))
          }
        />
        {children}
      </main>
    </AccountTheme>
  );
}
