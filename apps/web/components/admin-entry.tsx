'use client';
import Link from 'next/link';
import { Card } from 'antd';
import type { AccountSummary } from '@artzoo/domain';
import { PageHeading } from './page-heading';
import { useAuthSession } from './auth-session';
import HomeCardSurface from './home-card-surface';
import './admin-management/admin-management.css';

export default function AdminEntry({ user }: { user: AccountSummary }) {
  const { session, loading } = useAuthSession();
  const showSuper = !loading && session?.user?.id === user.id && session.user.adminRole === 'SUPER_ADMIN';
  const entries = [
    { title: '身份与邀请', href: '/admin/accounts' },
    { title: '申诉处理', href: '/admin/attendance-appeals' },
    { title: '相册精选', href: '/admin/featured' },
    { title: '公告管理', href: '/admin/announcements' },
    { title: '快捷入口管理', href: '/admin/quick-links' },
    { title: '联系留言', href: '/admin/contact-requests' },
    { title: '官方活动审核', href: '/admin/official-events' },
    ...(showSuper
      ? [
          { title: '账号停用与恢复', href: '/admin/account-lifecycle' },
          { title: '机器人管理', href: '/admin/bot-management' }
        ]
      : [])
  ];
  return (
    <main className="home-content admin-home">
      <div className="admin-page-heading">
        <PageHeading level={1} decoration="burger">
          管理员工作入口
        </PageHeading>
      </div>
      <div className="admin-entry-grid">
        {entries.map((entry) => (
          <HomeCardSurface key={entry.href} motionProfile="feed">
            <Card
              variant="borderless"
              classNames={{ root: 'paper-panel paper-activity', body: 'admin-entry-card' }}
            >
              <h3>
                <Link href={entry.href} data-home-card-link>
                  {entry.title}
                </Link>
              </h3>
            </Card>
          </HomeCardSurface>
        ))}
      </div>
    </main>
  );
}
