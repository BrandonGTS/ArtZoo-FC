'use client';
import { useEffect, useState } from 'react';
import { Button, Input } from 'antd';
import type { PublicSiteSettings } from '@artzoo/domain';
import { PageHeading } from '../page-heading';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { beijingFull } from '../activities/activity-ui';
import { SuperAdminOnly } from './super-admin-scope';
import { useManagementCommand, useManagementResource } from './management-api';
import { ManagementAudits } from './management-audits';
import './admin-management.css';
export default function PublicSettingsAdmin() {
  return (
    <SuperAdminOnly>
      <OwnedSettingsAdmin />
    </SuperAdminOnly>
  );
}
function OwnedSettingsAdmin() {
  const { notify, contextHolder } = useFeedbackMessage();
  const [reload, setReload] = useState(0),
    [locked, setLocked] = useState(false),
    [anchor, setAnchor] = useState<PublicSiteSettings | null>(null),
    [knownRevision, setKnownRevision] = useState(0),
    [replacing, setReplacing] = useState(false),
    [generation, setGeneration] = useState(0);
  const resource = useManagementResource<PublicSiteSettings>('/api/admin/public-settings?refresh=' + reload, {
    keepPrevious: true,
    revalidate: !locked
  });
  if (!resource.blocked && !anchor && resource.data) setAnchor(resource.data);
  if (resource.data && resource.data.revision > knownRevision) setKnownRevision(resource.data.revision);
  if (replacing && !resource.loading) {
    setReplacing(false);
    if (!resource.error && resource.data) {
      setAnchor(resource.data);
      setKnownRevision(resource.data.revision);
      setGeneration((value) => value + 1);
    }
  }
  function saved(settings: PublicSiteSettings) {
    setAnchor(settings);
    setKnownRevision(settings.revision);
    setReload((value) => value + 1);
  }
  if (resource.blocked) return null;
  return (
    <main className="home-content management-content" id="main-content">
      {contextHolder}
      <div className="management-heading">
        <PageHeading level={1} decoration="burger">
          公开 QQ 配置
        </PageHeading>
        <Button disabled={locked} href="/admin">
          返回管理入口
        </Button>
      </div>
      <section className="management-panel">
        <div className="management-error">
          <ErrorNotice message={resource.error} />
          {resource.error ? (
            <Button disabled={locked} onClick={() => setReload((value) => value + 1)}>
              重试读取
            </Button>
          ) : null}
        </div>
        {anchor ? (
          <SettingsForm
            key={anchor.revision + ':' + generation}
            settings={anchor}
            remoteRevision={knownRevision}
            replacing={replacing}
            onLock={setLocked}
            saved={saved}
            notify={notify}
            reload={() => {
              setReplacing(true);
              setReload((value) => value + 1);
            }}
          />
        ) : resource.loading ? (
          <p role="status">正在读取公开配置…</p>
        ) : null}
        <ManagementAudits scope="public-qq" refresh={reload} disabled={locked} />
      </section>
    </main>
  );
}
function SettingsForm({
  settings,
  remoteRevision,
  replacing,
  onLock,
  saved,
  notify,
  reload
}: {
  settings: PublicSiteSettings;
  remoteRevision: number;
  replacing: boolean;
  onLock(value: boolean): void;
  saved(value: PublicSiteSettings): void;
  notify(type: 'success' | 'error', content: string): void;
  reload(): void;
}) {
  const [qq, setQq] = useState(settings.adminQq ?? ''),
    [reason, setReason] = useState(''),
    [conflicted, setConflicted] = useState(false);
  const command = useManagementCommand<{ settings: PublicSiteSettings; replayed: boolean }>({
    success(result) {
      if (
        !result?.settings ||
        typeof result.settings.revision !== 'number' ||
        !(result.settings.adminQq === null || typeof result.settings.adminQq === 'string')
      )
        throw new Error('Invalid response');
      saved(result.settings);
      notify(
        'success',
        result.replayed ? '保存结果已确认' : result.settings.adminQq ? '公开 QQ 已保存' : '公开 QQ 已清除'
      );
    },
    failure(code) {
      if (code === 'CONFLICT') setConflicted(true);
    }
  });
  useEffect(() => {
    onLock(command.locked);
    return () => onLock(false);
  }, [command.locked, onLock]);
  useEffect(() => {
    if (command.error && !command.unknown) notify('error', command.error);
  }, [command.error, command.unknown, notify]);
  const stale = conflicted || remoteRevision > settings.revision;
  function save() {
    if (command.locked || stale || replacing) return;
    const value = qq.trim();
    if (value && !/^[1-9]\d{4,11}$/.test(value)) {
      command.setError('QQ 号码须为 5 至 12 位数字，且不能以 0 开头。');
      return;
    }
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    void command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/admin/public-settings',
      body: {
        adminQq: value || null,
        expectedRevision: settings.revision,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID()
      }
    });
  }
  return (
    <div className="management-form">
      <label className="management-qq-field" htmlFor="public-admin-qq">
        公开管理员 QQ
        <Input
          autoComplete="off"
          id="public-admin-qq"
          inputMode="numeric"
          maxLength={12}
          value={qq}
          disabled={command.locked || stale || replacing}
          onChange={(event) => setQq(event.target.value)}
        />
      </label>
      <p className="management-meta">留空并保存可清除公开联系方式。</p>
      <label htmlFor="public-qq-reason">
        操作原因
        <Input.TextArea
          autoComplete="off"
          id="public-qq-reason"
          rows={3}
          maxLength={500}
          value={reason}
          disabled={command.locked || stale || replacing}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {settings.updatedAt ? (
        <p className="management-meta">更新于 {beijingFull(settings.updatedAt)}</p>
      ) : null}
      {stale ? <ErrorNotice message="公开配置已更新，重新读取将放弃未保存的修改。" /> : null}
      <ErrorNotice message={command.error} />
      <div className="management-actions">
        {command.unknown ? (
          <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
            重试确认保存
          </Button>
        ) : stale ? (
          <Button loading={replacing} disabled={replacing} onClick={reload}>
            重新读取公开配置
          </Button>
        ) : (
          <Button type="primary" loading={command.busy} disabled={command.locked || replacing} onClick={save}>
            保存公开 QQ
          </Button>
        )}
      </div>
    </div>
  );
}
