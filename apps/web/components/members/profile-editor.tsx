'use client';

import { useRef, useState } from 'react';
import { Button, Cascader, Form, Input } from 'antd';
import {
  GAME_SERVER_REGIONS,
  validateGameNickname,
  validateGameServer,
  type MemberProfile,
  type ProfileInput
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { AccountTheme, applyFieldErrors, ErrorNotice } from '../account/account-ui';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import AvatarEditor from './avatar-editor';
import { QqBindingSettings } from './qq-binding-settings';
import { JobPicker } from './job-picker';
import { PlaystyleInput } from './playstyle-input';
import { MemberPaper } from './member-ui';

const serverOptions = GAME_SERVER_REGIONS.map(({ region, servers }) => ({
  value: region,
  label: region,
  children: servers.map((server) => ({ value: server, label: server }))
}));
type Values = {
  displayName: string;
  gameLocation?: [string, string];
  bio: string;
  commonJobs: string[];
  preferredPlaystyles: string[];
};
function formValues(profile: MemberProfile): Values {
  return {
    displayName: profile.displayName ?? '',
    gameLocation:
      profile.gameRegion && profile.gameServer ? [profile.gameRegion, profile.gameServer] : undefined,
    bio: profile.bio,
    commonJobs: profile.commonJobs,
    preferredPlaystyles: profile.preferredPlaystyles
  };
}
export function MemberProfileSettings({
  initial,
  onSaved
}: {
  initial: MemberProfile;
  onSaved?(profile: MemberProfile): void;
}) {
  const [form] = Form.useForm<Values>();
  const [profile, setProfile] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify, contextHolder } = useFeedbackMessage();
  const [needsReload, setNeedsReload] = useState(false);
  const lock = useRef(false);
  const { refresh } = useAuthSession();
  function refreshSession() {
    void refresh().catch(() => {});
  }
  async function save(values: Values) {
    if (lock.current || avatarBusy || needsReload) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: ProfileInput = {
        displayName: validateGameNickname(values.displayName),
        ...validateGameServer(values.gameLocation?.[0], values.gameLocation?.[1]),
        bio: values.bio ?? '',
        commonJobs: values.commonJobs ?? [],
        preferredPlaystyles: values.preferredPlaystyles ?? [],
        revision: profile.revision
      };
      const result = await accountRequest<MemberProfile>('/api/me/profile', { method: 'PATCH', body });
      setProfile(result);
      onSaved?.(result);
      form.setFieldsValue(formValues(result));
      notify('success', '资料已保存。');
      refreshSession();
    } catch (failure) {
      const detail = errorDetail(failure);
      setError(detail.message);
      applyFieldErrors(form, detail);
      notify('error', detail.message);
      if (
        detail.code === 'CONFLICT' ||
        detail.code === 'NETWORK_ERROR' ||
        detail.code === 'SERVICE_UNAVAILABLE'
      )
        setNeedsReload(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <AccountTheme>
      {contextHolder}
      <MemberPaper variant="profile" className="member-editor-paper">
        <AvatarEditor
          onSaveFeedback={notify}
          member={profile}
          disabled={busy || needsReload}
          onBusy={setAvatarBusy}
          onReloadRequired={(message) => {
            setNeedsReload(true);
            setError(message);
          }}
          onSaved={(result) => {
            setProfile(result);
            onSaved?.(result);
            refreshSession();
          }}
        />
        <Form
          autoComplete="off"
          form={form}
          name="member-profile"
          layout="vertical"
          initialValues={formValues(initial)}
          onFinish={save}
          requiredMark={false}
          disabled={busy || avatarBusy || needsReload}
          scrollToFirstError
        >
          <div className="member-settings-fields">
            <Form.Item
              name="displayName"
              label="昵称"
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
                options={serverOptions}
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
          </div>
          <Form.Item name="bio" label="个人简介">
            <Input.TextArea
              autoComplete="off"
              autoSize={{ minRows: 4, maxRows: 10 }}
              placeholder="向大家介绍一下自己"
            />
          </Form.Item>
          <Form.Item name="commonJobs" label="擅长的职业">
            <JobPicker disabled={busy || avatarBusy || needsReload} />
          </Form.Item>
          <Form.Item name="preferredPlaystyles" label="喜欢的玩法">
            <PlaystyleInput />
          </Form.Item>
          <ErrorNotice
            message={
              needsReload
                ? `${error ?? '资料版本已变化。'} 请先保留需要的编辑内容，再刷新页面查看最新资料。`
                : error
            }
          />
          <div className="member-form-actions">
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={busy || avatarBusy || needsReload}
            >
              保存修改
            </Button>
          </div>
        </Form>
      </MemberPaper>
      <QqBindingSettings />
    </AccountTheme>
  );
}
