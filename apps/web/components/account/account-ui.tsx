'use client';
import { useSyncExternalStore } from 'react';
import Image from 'next/image';
import { useHydrated } from './use-hydrated';
import { ConfigProvider, Modal, theme, type FormInstance } from 'antd';
import type { ApiError } from '@artzoo/domain';
import { PageHeading } from '../home-content';
import closeIcon from './assets/close.svg';
import errorIcon from './assets/error.svg';
import eyeOff from './assets/eye-off.svg';
import styles from './account.module.css';

function subscribeViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const viewportWidthSnapshot = () => window.innerWidth;
const serverViewportWidthSnapshot = () => 0;

export const membershipLabels = { MEMBER: '正式成员', FRIEND: '朋友' };
export const membershipOptions = Object.entries(membershipLabels).map(([value, label]) => ({ value, label }));

export function ErrorNotice({ message }: { message?: string | null }) {
  const { token } = theme.useToken();
  return message ? (
    <p role="alert" className={styles.error} style={{ color: token.colorError }}>
      <Image src={errorIcon} alt="" width={20} height={20} unoptimized />
      {message}
    </p>
  ) : null;
}
export function applyFieldErrors(form: FormInstance, error: ApiError) {
  if (error.fieldErrors)
    form.setFields(Object.entries(error.fieldErrors).map(([name, message]) => ({ name, errors: [message] })));
}
export function passwordIcon(visible: boolean) {
  return <Image src={eyeOff} alt={visible ? '隐藏密码' : '显示密码'} width={20} height={20} unoptimized />;
}
export function AccountTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        components: {
          Form: { itemMarginBottom: 16, verticalLabelPadding: '0 0 6px', labelHeight: 26 },
          Input: { paddingInline: 16, paddingBlock: 6, paddingInlineLG: 16, paddingBlockLG: 6 },
          Tag: { defaultBg: 'var(--artzoo-surface)', defaultColor: 'var(--artzoo-heading)' }
        }
      }}
    >
      {children}
    </ConfigProvider>
  );
}
export function AccountModal({
  variant,
  open,
  busy = false,
  onClose,
  children
}: {
  variant: 'login' | 'register' | 'reset';
  open: boolean;
  busy?: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const hydrated = useHydrated();
  // The root reserves a scrollbar gutter, which also reduces CSS vw units.
  // Use the actual browser viewport width only after the hydration boundary.
  const viewportWidth = useSyncExternalStore(
    subscribeViewport,
    viewportWidthSnapshot,
    serverViewportWidthSnapshot
  );
  if (!hydrated) return null;
  const title = (
    <div className={styles.title}>
      <PageHeading decoration={variant === 'login' ? 'burger' : variant === 'register' ? 'tomato' : 'cheese'}>
        {variant === 'login' ? '登录' : variant === 'register' ? '邀请注册' : '找回密码'}
      </PageHeading>
    </div>
  );
  return (
    <AccountTheme>
      <Modal
        open={open}
        width={464}
        footer={null}
        destroyOnHidden
        title={title}
        onCancel={() => {
          if (!busy) onClose();
        }}
        keyboard={!busy}
        mask={{ closable: false }}
        closable={{ disabled: busy, 'aria-label': '关闭' }}
        closeIcon={<Image src={closeIcon} alt="" width={20} height={20} unoptimized />}
        classNames={{
          root: styles.modal,
          wrapper: styles.wrapper,
          container: styles.paper,
          header: styles.header,
          body: styles.body
        }}
        styles={{
          wrapper: { width: viewportWidth || undefined, right: 'auto' },
          mask: { backgroundColor: 'rgba(37,75,56,.18)' },
          container: { padding: '24px 32px', boxShadow: 'none' },
          header: { marginBottom: 20 },
          body: { padding: 0 }
        }}
      >
        {children}
      </Modal>
    </AccountTheme>
  );
}
