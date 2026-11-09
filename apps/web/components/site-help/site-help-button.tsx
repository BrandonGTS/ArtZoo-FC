'use client';
import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode
} from 'react';
import { FloatButton, Popover } from 'antd';
import { usePathname } from 'next/navigation';
import { useAuthSession } from '../auth-session';
import { useSiteHelp } from './site-help-provider';
import './site-help.css';
const HelpPanel = lazy(() => import('./site-help-panel'));
function HelpEntry({ icon }: { icon: ReactNode }) {
  const { cancelStart } = useSiteHelp(),
    [open, setOpen] = useState(false),
    trigger = useRef<ComponentRef<typeof FloatButton>>(null);
  const close = useCallback(() => {
    cancelStart();
    setOpen(false);
    queueMicrotask(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
    });
  }, [cancelStart]);
  useEffect(() => {
    if (!open) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [open, close]);
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      placement="leftBottom"
      arrow={false}
      zIndex={90}
      destroyOnHidden
      classNames={{ root: 'site-help-popover' }}
      styles={{
        container: {
          padding: 16,
          boxShadow: 'none',
          background: 'var(--artzoo-surface)',
          border: '1px solid var(--artzoo-line)'
        }
      }}
      content={
        <Suspense
          fallback={
            <section className="site-help-panel" role="status">
              正在打开帮助…
            </section>
          }
        >
          {open ? <HelpPanel onClose={close} /> : null}
        </Suspense>
      }
    >
      <FloatButton
        ref={trigger}
        aria-label="网站使用帮助"
        aria-haspopup="dialog"
        aria-expanded={open}
        tooltip={{ title: '网站使用帮助', placement: 'left' }}
        icon={icon}
      />
    </Popover>
  );
}
export default function SiteHelpButton({ icon }: { icon: ReactNode }) {
  const pathname = usePathname(),
    { session } = useAuthSession(),
    actor = session?.user;
  return (
    <HelpEntry
      key={[pathname, actor?.id ?? 'guest', actor?.membership, actor?.adminRole].join(':')}
      icon={icon}
    />
  );
}
