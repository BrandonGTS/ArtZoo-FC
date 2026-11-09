'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Cascader, Form, Input, Tag } from 'antd';
import {
  GAME_SERVER_REGIONS,
  validateGameServer,
  validateGameNickname,
  type AuthConfig,
  type Membership
} from '@artzoo/domain';
import { accountRequest, errorDetail } from './api';
import { applyFieldErrors, ErrorNotice, passwordIcon } from './account-ui';
import { useResource } from './use-resource';
import styles from './account.module.css';
import { mainlandPhoneE164, mainlandPhoneInput, validateMainlandPhone } from './phone-input';

const gameServerOptions = GAME_SERVER_REGIONS.map(({ region, servers }) => ({
  value: region,
  label: region,
  children: servers.map((server) => ({ value: server, label: server }))
}));

type Values = {
  gameLocation?: [string, string];
  displayName?: string;
  phone: string;
  code: string;
  password: string;
  confirmPassword: string;
};
export default function VerificationForm({
  mode,
  invitation,
  initialPhone = '',
  onLogin,
  onComplete,
  onBusy
}: {
  mode: 'register' | 'reset';
  invitation?: { token: string; membership: Membership; expiresAt: string };
  initialPhone?: string;
  onLogin(phone: string): void;
  onComplete(phone: string): void | Promise<void>;
  onBusy(busy: boolean): void;
}) {
  const [form] = Form.useForm<Values>();
  const config = useResource<AuthConfig>('/api/auth/config');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState<'send' | 'submit' | null>(null);
  const lock = useRef(false);
  const cooldown = useRef(0);
  useEffect(() => {
    const timer = setInterval(
      () => setRemaining(Math.max(0, Math.ceil((cooldown.current - Date.now()) / 1000))),
      500
    );
    return () => clearInterval(timer);
  }, []);
  function setCooldown(until: number) {
    cooldown.current = until;
    setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  }
  async function sendCode() {
    if (lock.current || cooldown.current > Date.now()) return;
    lock.current = true;
    setBusy('send');
    onBusy(true);
    setError(null);
    try {
      const { phone } = await form.validateFields(['phone']);
      const result = await accountRequest<{ expiresAt: string; resendAvailableAt: string }>(
        '/api/auth/verification-codes',
        {
          method: 'POST',
          body: {
            phone: mainlandPhoneE164(phone),
            purpose: mode === 'register' ? 'REGISTER' : 'RESET_PASSWORD',
            invitationToken: invitation?.token
          }
        }
      );
      setCooldown(Math.max(Date.now() + 60_000, Date.parse(result.resendAvailableAt) || 0));
      setSent(true);
      form.setFieldValue('code', '');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        const detail = errorDetail(error);
        setError(detail.message);
        applyFieldErrors(form, detail);
        if (detail.retryAfterSeconds) setCooldown(Date.now() + detail.retryAfterSeconds * 1000);
      }
    } finally {
      lock.current = false;
      setBusy(null);
      onBusy(false);
    }
  }
  async function submit(values: Values) {
    if (lock.current) return;
    lock.current = true;
    setBusy('submit');
    onBusy(true);
    setError(null);
    try {
      await accountRequest(mode === 'register' ? '/api/auth/register' : '/api/auth/reset-password', {
        method: 'POST',
        body: {
          phone: mainlandPhoneE164(values.phone),
          code: values.code,
          password: values.password,
          confirmPassword: values.confirmPassword,
          ...(mode === 'register'
            ? {
                invitationToken: invitation?.token,
                displayName: validateGameNickname(values.displayName),
                ...validateGameServer(values.gameLocation?.[0], values.gameLocation?.[1])
              }
            : {})
        }
      });
      form.resetFields(['password', 'confirmPassword', 'code']);
      await onComplete(values.phone);
    } catch (error) {
      const detail = errorDetail(error);
      setError(detail.message);
      form.setFieldsValue({ password: '', confirmPassword: '', code: '' });
      applyFieldErrors(form, detail);
    } finally {
      lock.current = false;
      setBusy(null);
      onBusy(false);
    }
  }
  const unavailable =
    config.loading || !!config.error || !config.data?.sms.available || (mode === 'register' && !invitation);
  return (
    <>
      {invitation ? (
        <div className={styles.identity}>
          <span className={styles.identityLabel}>受邀身份</span>
          <Tag
            variant="solid"
            color={invitation.membership === 'MEMBER' ? '#254B38' : '#D3972A'}
            className={styles.identityTag}
          >
            {invitation.membership === 'MEMBER' ? '正式成员' : '其他亲友'}
          </Tag>
        </div>
      ) : null}
      <Form
        autoComplete="off"
        form={form}
        name={`account-${mode}`}
        layout="vertical"
        requiredMark={false}
        disabled={!!busy}
        preserve={false}
        clearOnDestroy
        initialValues={{ phone: initialPhone }}
        onFinish={submit}
      >
        {mode === 'register' ? (
          <Form.Item
            name="displayName"
            label="游戏昵称"
            rules={[
              {
                required: true,
                validator: async (_, value: unknown) => {
                  validateGameNickname(value);
                }
              }
            ]}
          >
            <Input autoComplete="off" placeholder="请输入1–30个字符的游戏昵称" />
          </Form.Item>
        ) : null}
        {mode === 'register' ? (
          <Form.Item
            name="gameLocation"
            label="大区 / 服务器"
            rules={[
              {
                required: true,
                validator: async (_, value: unknown) => {
                  if (!Array.isArray(value) || value.length !== 2) throw new Error('请选择大区和服务器');
                  validateGameServer(value[0], value[1]);
                }
              }
            ]}
          >
            <Cascader
              options={gameServerOptions}
              placeholder="请选择大区 / 服务器"
              styles={{ root: { width: '100%' } }}
              displayRender={(labels) => labels.join(' / ')}
              showSearch={{
                filter: (input, path) =>
                  path.some((option) =>
                    String(option.label).toLowerCase().includes(input.trim().toLowerCase())
                  ),
                render: (_, path) => path.map((option) => option.label).join(' / ')
              }}
              notFoundContent="未找到匹配的大区或服务器"
            />
          </Form.Item>
        ) : null}
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
            onChange={() => setSent(false)}
          />
        </Form.Item>
        <Form.Item label={mode === 'register' ? '手机验证码' : '验证码'} htmlFor={`account-${mode}_code`}>
          <div className={styles.codeRow}>
            <Form.Item
              name="code"
              noStyle
              rules={[
                { required: true, message: '请输入验证码' },
                { pattern: /^\d{6}$/, message: '请输入6位数字验证码' }
              ]}
            >
              <Input
                id={`account-${mode}_code`}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                placeholder="请输入验证码"
              />
            </Form.Item>
            <Button
              loading={busy === 'send'}
              disabled={!!busy || !!unavailable || remaining > 0}
              onClick={sendCode}
            >
              {remaining > 0 ? `${remaining} 秒后重发` : '获取验证码'}
            </Button>
          </div>
        </Form.Item>
        <Form.Item
          name="password"
          label={mode === 'register' ? '设置密码' : '新密码'}
          rules={[
            { required: true, message: '请设置密码' },
            { min: 8, max: 30, message: '密码须为8–30位' },
            { pattern: /^[\x20-\x7E]+$/, message: '密码可使用数字、英文字母和符号' }
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            iconRender={passwordIcon}
            placeholder="8–30位数字、英文字母或符号"
          />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label={mode === 'register' ? '确认密码' : '确认新密码'}
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                return !value || value === getFieldValue('password')
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的密码不一致'));
              }
            })
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            iconRender={passwordIcon}
            placeholder="请再次输入密码"
          />
        </Form.Item>
        <ErrorNotice message={error ?? config.error} />
        {sent ? (
          <p role="status" className={styles.note}>
            验证码请求已受理，5分钟内有效；再次获取后旧验证码失效。
          </p>
        ) : null}
        <Button
          type="primary"
          htmlType="submit"
          block
          loading={busy === 'submit'}
          disabled={!!busy || !!unavailable}
        >
          {mode === 'register' ? '完成注册' : '重置密码'}
        </Button>
        <div className={styles.footer}>
          <Button
            type="link"
            className={styles.link}
            disabled={!!busy}
            onClick={() => onLogin(form.getFieldValue('phone') ?? '')}
          >
            返回登录
          </Button>
        </div>
      </Form>
    </>
  );
}
