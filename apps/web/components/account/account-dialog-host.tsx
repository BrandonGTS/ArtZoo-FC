'use client';
import { useState } from 'react';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { AccountModal } from './account-ui';
import { safeReturnTo } from './api';
import LoginForm from './login-form';
import { useAuthSession } from '../auth-session';
import VerificationForm from './verification-form';

export default function AccountDialogHost(props: {
  open: boolean;
  returnTo: string;
  onClose(): void;
  onAuthenticated(): Promise<void>;
}) {
  // Mount per opening so passwords, codes and the forgotten-password view are cleared.
  return props.open ? <DialogContent {...props} /> : null;
}
function DialogContent({
  returnTo,
  onClose,
  onAuthenticated
}: {
  returnTo: string;
  onClose(): void;
  onAuthenticated(): Promise<void>;
}) {
  const router = useRouter();
  const { passwordResetCompleted } = useAuthSession();
  const [view, setView] = useState<'login' | 'reset'>('login');
  const [phone, setPhone] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <AccountModal variant={view} open onClose={onClose} busy={busy}>
      {view === 'login' ? (
        <LoginForm
          phone={phone}
          notice={notice}
          onBusy={setBusy}
          onForgot={(value) => {
            setPhone(value);
            setNotice('');
            setView('reset');
          }}
          onAuthenticated={async () => {
            await onAuthenticated();
            onClose();
            router.replace(safeReturnTo(returnTo));
            router.refresh();
          }}
        />
      ) : (
        <VerificationForm
          mode="reset"
          initialPhone={phone}
          onBusy={setBusy}
          onLogin={(value) => {
            setPhone(value);
            setView('login');
          }}
          onComplete={async (value) => {
            await passwordResetCompleted().catch(() => {});
            setPhone(value);
            setNotice('密码已重置，请重新登录。所有设备的旧会话已退出。');
            setView('login');
          }}
        />
      )}
    </AccountModal>
  );
}
