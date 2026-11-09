'use client';
import { useState } from 'react';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { Button } from 'antd';
import type { Membership } from '@artzoo/domain';
import { AccountModal, ErrorNotice } from '../account/account-ui';
import VerificationForm from '../account/verification-form';
import { useResource } from '../account/use-resource';
import { useAuthSession } from '../auth-session';
import styles from '../account/account.module.css';

export default function InvitationRegistration({ token }: { token: string }) {
  const router = useRouter();
  const { openLogin } = useAuthSession();
  const invitation = useResource<{ membership: Membership; expiresAt: string }>(
    `/api/invitations/${encodeURIComponent(token)}`
  );
  const [busy, setBusy] = useState(false);
  function login() {
    router.replace('/login?completed=registered');
    openLogin('/');
  }
  return (
    <AccountModal variant="register" open busy={busy} onClose={() => router.replace('/')}>
      {invitation.loading ? (
        <p role="status" className={styles.note}>
          正在核验邀请…
        </p>
      ) : null}
      <ErrorNotice message={invitation.error} />
      {invitation.data ? (
        <VerificationForm
          mode="register"
          invitation={{ token, ...invitation.data }}
          onBusy={setBusy}
          onLogin={() => {
            router.replace('/login');
            openLogin('/');
          }}
          onComplete={login}
        />
      ) : null}
      {invitation.error ? (
        <Button block onClick={() => router.replace('/')}>
          返回首页
        </Button>
      ) : null}
    </AccountModal>
  );
}
