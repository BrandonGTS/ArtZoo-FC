'use client';
import { useRef, useState } from 'react';
import { Button, Form, Input } from 'antd';
import type { SessionSnapshot } from '@artzoo/domain';
import { accountRequest, errorDetail } from './api';
import { applyFieldErrors, ErrorNotice, passwordIcon } from './account-ui';
import styles from './account.module.css';
import { mainlandPhoneE164, mainlandPhoneInput, validateMainlandPhone } from './phone-input';

export default function LoginForm({
  phone,
  notice,
  onForgot,
  onAuthenticated,
  onBusy
}: {
  phone: string;
  notice: string;
  onForgot(phone: string): void;
  onAuthenticated(): Promise<void>;
  onBusy(busy: boolean): void;
}) {
  const [form] = Form.useForm<{ phone: string; password: string }>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function submit(values: { phone: string; password: string }) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const session = await accountRequest<SessionSnapshot>('/api/auth/login', {
        method: 'POST',
        body: { ...values, phone: mainlandPhoneE164(values.phone) }
      });
      if (!session.user) throw new Error('No session');
      form.setFieldValue('password', '');
      await onAuthenticated();
    } catch (error) {
      const detail = errorDetail(error);
      setError(detail.message);
      form.setFieldValue('password', '');
      applyFieldErrors(form, detail);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <>
      {notice ? (
        <p role="status" className={styles.success}>
          {notice}
        </p>
      ) : null}
      <Form
        autoComplete="off"
        form={form}
        name="account-login"
        layout="vertical"
        requiredMark={false}
        disabled={busy}
        preserve={false}
        clearOnDestroy
        initialValues={{ phone }}
        onFinish={submit}
      >
        <Form.Item
          name="phone"
          label="中国大陆手机号"
          normalize={mainlandPhoneInput}
          rules={[{ validator: validateMainlandPhone }]}
        >
          <Input
            prefix={<span aria-label="中国大陆区号">+86</span>}
            type="tel"
            inputMode="tel"
            autoComplete="username"
            maxLength={40}
            placeholder="请输入11位手机号"
          />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password
            autoComplete="current-password"
            iconRender={passwordIcon}
            placeholder="请输入密码"
          />
        </Form.Item>
        <div className={styles.errorSlot}>
          <ErrorNotice message={error} />
        </div>
        <Button type="primary" block htmlType="submit" loading={busy}>
          登录
        </Button>
        <div className={styles.footer}>
          <Button
            type="link"
            className={styles.link}
            disabled={busy}
            onClick={() => onForgot(form.getFieldValue('phone') ?? '')}
          >
            忘记密码？
          </Button>
        </div>
      </Form>
    </>
  );
}
