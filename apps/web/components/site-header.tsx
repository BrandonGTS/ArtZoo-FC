'use client';

import { cloneElement, useState, type ReactElement } from 'react';
import { usePathname } from 'next/navigation';
import { useAuthSession } from './auth-session';
import { useMessageState } from './messages/message-state';
import DailyToolbarIcon from './daily/daily-toolbar-icon';
import './site-header-personal.css';
import './site-header-compact.css';
import { useCompactHeader } from './use-compact-header';
import DailyCheckinBlock from './checkin/daily-checkin-block';
import './messages/messages.css';
import Link from 'next/link';
import Image from 'next/image';
import { Avatar, Button, Dropdown, Menu, Modal, Tag, type MenuProps } from 'antd';

function LocalIcon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <Image
      className="local-icon"
      src={`/artzoo/icons/${name}.svg`}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      unoptimized
      aria-hidden
    />
  );
}

function NavigationLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="nav-submenu-label">
      {children}
      <LocalIcon name="chevron-down" size={16} />
    </span>
  );
}

const navigation: MenuProps['items'] = [
  { key: 'home', label: <Link href="/">首页</Link> },
  { key: 'albums', label: <Link href="/albums">相册</Link> },
  { key: 'members', label: <Link href="/members">成员名册</Link> },
  { key: 'daily', label: <Link href="/daily">日常交流</Link> },
  {
    key: 'activities',
    label: <NavigationLabel>活动</NavigationLabel>,
    popupOffset: [-16, 0],
    children: [
      { key: '正式活动', label: <Link href="/activities">正式活动</Link> },
      { key: '心愿', label: <Link href="/wishes">心愿板</Link> },
      { key: '抽奖', label: <Link href="/lotteries">抽奖</Link> }
    ]
  },
  {
    key: 'teams',
    label: <NavigationLabel>固定队</NavigationLabel>,
    popupOffset: [-16, 0],
    children: [
      { key: '队伍招募', label: <Link href="/teams">队伍招募</Link> },
      { key: '我的队伍', label: <Link href="/me/teams">我的队伍</Link> }
    ]
  },
  { key: 'knowledge', label: <Link href="/knowledge">内容分享</Link> }
];

const basePersonalItems: MenuProps['items'] = [
  { type: 'divider' },
  { key: '个人主页', label: '个人主页' },
  { key: '我的活动', label: <Link href="/me/activities">我的活动</Link> },
  { key: '消息中心', label: <Link href="/me/messages">消息中心</Link> },
  { key: '处罚与申诉', label: <Link href="/me/activity-penalties">处罚与申诉</Link> },
  { type: 'divider' },
  { key: 'logout', label: '退出登录', danger: true }
];

const navigationMenuStyles: MenuProps['styles'] = {
  popup: { root: { borderRadius: 12 } },
  subMenu: {
    item: {
      width: '100%',
      boxSizing: 'border-box',
      margin: 0,
      paddingInline: 12,
      borderRadius: 4,
      height: 40,
      lineHeight: '40px',
      flexShrink: 0
    }
  }
};

const personalMenuStyles: MenuProps['styles'] = {
  root: {
    width: '100%',
    margin: '12px 0 0',
    padding: 0,
    border: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none'
  },
  item: {
    width: '100%',
    boxSizing: 'border-box',
    margin: 0,
    padding: '11px 16px',
    minHeight: 48,
    height: 'auto',
    lineHeight: '26px',
    borderRadius: 8
  }
};

export default function SiteHeader({ navigationPath }: { navigationPath?: string }) {
  const actualPath = usePathname();
  const pathname = navigationPath ?? actualPath;
  const { unreadCount, systemUnreadCount } = useMessageState();
  const { session, avatar, loading, error, openLogin, logout } = useAuthSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const user = session?.user;
  const administrator = user?.adminRole === 'ADMIN' || user?.adminRole === 'SUPER_ADMIN';
  const identity = user?.displayName || user?.phoneMasked || '';
  const personalItems: MenuProps['items'] = [
    ...(basePersonalItems || []).map((item) => {
      if (item?.key === 'logout')
        return { ...item, disabled: loggingOut, label: loggingOut ? '正在退出…' : '退出登录' };
      if (item?.key === '个人主页' && user)
        return { ...item, label: <Link href={`/members/${user.id}`}>个人主页</Link> };
      return item;
    })
  ];
  if (administrator) personalItems.splice(5, 0, { key: 'admin', label: <Link href="/admin">管理入口</Link> });
  const [notice, setNotice] = useState<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const { compact, sentinelRef } = useCompactHeader(() => {
    // Existing portal menus must not retain coordinates from the previous layout.
    setOpenKeys([]);
    setPersonalOpen(false);
  });

  function explainFeature(key: string) {
    setOpenKeys([]);
    setPersonalOpen(false);
    setNotice(`${key}尚未开放。后续接入后即可使用。`);
  }

  return (
    <>
      <div className="site-header-slot" data-compact={compact}>
        <span ref={sentinelRef} className="site-header-sentinel" aria-hidden />
        <header className="site-header-wrap">
          <div className="site-header">
            <Link href="/" className="site-logo" aria-label="ArtZoo 首页">
              <span className="site-logo-art" aria-hidden />
            </Link>
            <nav className="site-navigation" aria-label="主要导航">
              <Menu
                mode="horizontal"
                disabledOverflow
                selectedKeys={
                  pathname === '/'
                    ? ['home']
                    : pathname.startsWith('/albums')
                      ? ['albums']
                      : pathname.startsWith('/members')
                        ? ['members']
                        : pathname.startsWith('/daily')
                          ? ['daily']
                          : pathname.startsWith('/knowledge')
                            ? ['knowledge']
                            : pathname.startsWith('/resources')
                              ? ['resource-catalog']
                              : pathname.startsWith('/lotteries')
                                ? ['抽奖']
                                : pathname.startsWith('/wishes')
                                  ? ['心愿']
                                  : pathname.startsWith('/activities')
                                    ? ['正式活动']
                                    : pathname.startsWith('/me/teams')
                                      ? ['我的队伍']
                                      : pathname.startsWith('/teams')
                                        ? ['队伍招募']
                                        : []
                }
                openKeys={openKeys}
                onOpenChange={setOpenKeys}
                items={navigation}
                expandIcon={<LocalIcon name="chevron-down" size={16} />}
                classNames={{
                  root: 'main-menu',
                  popup: { root: 'navigation-popup' },
                  subMenu: { item: 'navigation-popup-item' }
                }}
                styles={navigationMenuStyles}
                onClick={({ key }) => {
                  if (
                    key !== 'home' &&
                    key !== 'albums' &&
                    key !== 'members' &&
                    key !== '正式活动' &&
                    key !== '心愿' &&
                    key !== '抽奖' &&
                    key !== '队伍招募' &&
                    key !== '我的队伍' &&
                    key !== 'daily' &&
                    key !== 'knowledge' &&
                    key !== 'resource-catalog'
                  )
                    explainFeature(key);
                  else setOpenKeys([]);
                }}
              />
            </nav>
            <div className={user ? 'personal-entry' : 'personal-entry guest-entry'}>
              {!user ? (
                <Button
                  className="login-entry"
                  loading={loading}
                  onClick={() => (error ? setNotice(error) : openLogin(pathname))}
                >
                  {loading ? '读取中' : error ? '状态异常' : '登录'}
                </Button>
              ) : (
                <>
                  <Dropdown
                    trigger={['hover', 'click']}
                    placement="bottomRight"
                    open={personalOpen}
                    onOpenChange={setPersonalOpen}
                    classNames={{ root: 'personal-dropdown' }}
                    menu={{
                      items: personalItems,
                      selectable: false,
                      onClick: async ({ key }) => {
                        setPersonalOpen(false);
                        if (
                          key === 'admin' ||
                          key === '个人主页' ||
                          key === '我的活动' ||
                          key === '处罚与申诉' ||
                          key === '消息中心'
                        )
                          return;
                        if (key === 'logout') {
                          setLoggingOut(true);
                          const success = await logout();
                          setLoggingOut(false);
                          if (!success) setNotice('退出登录失败，当前登录状态未作成功处理。请稍后再操作。');
                        } else explainFeature(key);
                      }
                    }}
                    popupRender={(menu) => (
                      <div className="personal-panel">
                        <div className="personal-identity personal-identity-with-server">
                          <div className="personal-identity-name">
                            <span title={identity}>{identity}</span>
                            {user.gameServer ? (
                              <span className="personal-identity-server">
                                <DailyToolbarIcon kind="server" />
                                {user.gameServer}
                              </span>
                            ) : null}
                          </div>
                          <Tag
                            variant="solid"
                            color={user.membership === 'MEMBER' ? '#254B38' : '#D3972A'}
                            className="personal-membership-tag"
                          >
                            {user.membership === 'MEMBER' ? '正式成员' : '其他亲友'}
                          </Tag>
                        </div>
                        <DailyCheckinBlock active={personalOpen} />
                        {/* AntD 6.6.5 composes Dropdown's Menu before popupRender; apply list semantics here last. */}
                        {cloneElement(menu as ReactElement<MenuProps>, {
                          classNames: { root: 'personal-menu-list' },
                          styles: personalMenuStyles
                        })}
                      </div>
                    )}
                  >
                    <Button
                      type="text"
                      className="avatar-trigger"
                      aria-label={`${identity}，打开个人菜单`}
                      aria-expanded={personalOpen}
                    >
                      <Avatar size={40} src={avatar?.smallUrl} className="visitor-avatar">
                        {Array.from(identity)[0] || '我'}
                      </Avatar>
                      {(unreadCount ?? 0) > 0 ? (
                        <span
                          className="personal-unread-points"
                          aria-label={(systemUnreadCount ?? 0) > 0 ? '有未读消息和系统消息' : '有未读消息'}
                        >
                          <span className="personal-unread-green" />
                          {(systemUnreadCount ?? 0) > 0 ? <span className="personal-unread-red" /> : null}
                        </span>
                      ) : null}
                    </Button>
                  </Dropdown>
                </>
              )}
            </div>
          </div>
        </header>
      </div>
      <Modal
        open={notice !== null}
        title={error ? '账号状态提示' : '功能尚未开放'}
        onCancel={() => setNotice(null)}
        width={464}
        classNames={{ body: 'feature-notice' }}
        footer={
          <Button type="primary" onClick={() => setNotice(null)}>
            知道了
          </Button>
        }
      >
        <p>{notice}</p>
      </Modal>
    </>
  );
}
