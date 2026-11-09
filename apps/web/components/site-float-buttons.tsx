'use client';

import { useEffect, useState } from 'react';
import { ConfigProvider, FloatButton } from 'antd';
import { useAuthSession } from './auth-session';
import { useMessageState } from './messages/message-state';
import { useUserRouter } from './user-operation-provider';
import DailyActionIcon from './daily/daily-action-icon';
import QuickLinksButton from './quick-links/quick-links-button';
import SiteHelpButton from './site-help/site-help-button';
import './site-float-buttons.css';

// This control is always present (visibilityHeight=0), so no appear/leave transition
// is needed. Keep its first DOM identical on the server and during hydration.
const alwaysVisibleBackTopTheme = { token: { motion: false } };

function ToolIcon({ kind }: { kind: 'quick' | 'help' | 'top' }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'quick' ? (
        <>
          <path d="m10 13 4-4" />
          <path d="M8 15H6a4 4 0 0 1 0-8h5M16 9h2a4 4 0 0 1 0 8h-5" />
        </>
      ) : null}
      {kind === 'help' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01" />
        </>
      ) : null}
      {kind === 'top' ? (
        <>
          <path d="M5 4h14M12 20V8m-5 5 5-5 5 5" />
        </>
      ) : null}
    </svg>
  );
}

export default function SiteFloatButtons() {
  const { session, loading, openLogin } = useAuthSession();
  const { unreadCount } = useMessageState();
  const router = useUserRouter();
  const [atTop, setAtTop] = useState(true);
  const count = !loading && session?.user ? unreadCount : null;

  useEffect(() => {
    const update = () => setAtTop(window.scrollY <= 1);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  function openMessages() {
    if (loading) return;
    if (session?.user) router.push('/me/messages');
    else openLogin('/me/messages');
  }

  return (
    <FloatButton.Group
      className="site-float-tools"
      shape="circle"
      style={{ zIndex: 80 }}
      classNames={{ list: 'site-float-tools-list' }}
    >
      <FloatButton
        aria-label={count && count > 0 ? `消息中心，${count} 条未读消息` : '消息中心'}
        tooltip={{ title: '消息中心', placement: 'left' }}
        disabled={loading}
        onClick={openMessages}
        icon={<DailyActionIcon kind="reply" active={false} />}
        badge={{ count: count ?? 0, showZero: false, overflowCount: 99, color: 'var(--artzoo-primary)' }}
      />
      <QuickLinksButton icon={<ToolIcon kind="quick" />} />
      <SiteHelpButton icon={<ToolIcon kind="help" />} />
      <ConfigProvider theme={alwaysVisibleBackTopTheme}>
        <FloatButton.BackTop
          aria-label="回到顶部"
          tooltip={{ title: '回到顶部', placement: 'left' }}
          visibilityHeight={0}
          disabled={atTop}
          duration={300}
          icon={<ToolIcon kind="top" />}
        />
      </ConfigProvider>
    </FloatButton.Group>
  );
}
