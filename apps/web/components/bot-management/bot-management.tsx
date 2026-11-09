'use client';
import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Switch, Tag, theme } from 'antd';
import {
  BOT_LABELS,
  BOT_NOTICE_KINDS,
  BOT_TEMPLATE_KINDS,
  BOT_PARAMETER_RULES,
  BOT_REMINDER_LIMITS,
  botReminderLabel,
  botConfigForEditing,
  botEditorStatus,
  botPreviewValues,
  botTemplateVariables,
  type BotEditingConfig,
  type BotManagementSettings,
  type BotTemplateSelection,
  type BotTemplateKind,
  type BotTestStatus
} from '@artzoo/domain';
import { BotGroupPanel, type BotGroupList } from './bot-group-panel';
import { SuperAdminOnly } from '../admin-management/super-admin-scope';
import { useManagementCommand, useManagementResource } from '../admin-management/management-api';
import { CollectionTabs } from '../collection-controls';
import { ActivityPaper } from '../activities/activity-ui';
import { PageHeading } from '../page-heading';
import { AdminReturnLink } from '../admin-return-link';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import '../admin-management/admin-management.css';
import './bot-management.css';
const TABS = [
  { key: 'parameters', label: '参数配置' },
  { key: 'templates', label: '消息模板' }
];
const STATES = {
  UNSAVED: '未保存',
  CHANGED: '配置已更新',
  UNPUBLISHED: '尚未生效',
  PENDING: '等待机器人采用',
  APPLIED: '已生效',
  FAILED: '采用失败',
  STALE: '生效状态待确认'
};
export default function BotManagement() {
  return (
    <SuperAdminOnly>
      <OwnedBotManagement />
    </SuperAdminOnly>
  );
}
function OwnedBotManagement() {
  const { token } = theme.useToken();
  const [tab, setTab] = useState('parameters'),
    [reload, setReload] = useState(0),
    [form, setForm] = useState<BotEditingConfig | null>(null),
    [anchor, setAnchor] = useState<BotManagementSettings | null>(null),
    [selected, setSelected] = useState<BotTemplateSelection>('PUBLISHED'),
    [preview, setPreview] = useState<string | null>(null),
    [confirm, setConfirm] = useState(false),
    [conflict, setConflict] = useState(false);
  const [groupReload, setGroupReload] = useState(0),
    [testViewOpened, setTestViewOpened] = useState(false);
  const [probeConfirm, setProbeConfirm] = useState(false),
    [probeUsed, setProbeUsed] = useState(false);
  const [testConfirm, setTestConfirm] = useState(false),
    [targetGroup, setTargetGroup] = useState(''),
    [testReload, setTestReload] = useState(0),
    [lastTestId, setLastTestId] = useState<string | null>(null);
  const { notify, contextHolder } = useFeedbackMessage();
  const testCommand = useManagementCommand<Record<string, unknown>>({
    success(value) {
      if (typeof value.testId !== 'string') throw new Error('Invalid test result');
      setLastTestId(value.testId);
      if (probeConfirm) setProbeUsed(true);
      setProbeConfirm(false);
      setTestConfirm(false);
      setTestReload((x) => x + 1);
      notify('info', '测试消息已排队');
    },
    failure() {
      setProbeConfirm(false);
      setTestConfirm(false);
    }
  });
  const command = useManagementCommand<Record<string, unknown>>({
    success(result, request) {
      if (request.kind !== 'json') throw new Error('Invalid response');
      if (request.path.endsWith('/preview')) {
        if (typeof result.text !== 'string' || result.simulation !== true) throw new Error('Invalid preview');
        setPreview(result.text);
      } else {
        if (!Number.isSafeInteger(result.draftRevision) || !Number.isSafeInteger(result.publishedVersion))
          throw new Error('Invalid version');
        setAnchor(null);
        setForm(null);
        setReload((x) => x + 1);
        setConfirm(false);
        setConflict(false);
        notify('success', result.unchanged ? '配置已保存' : '已保存，等待机器人采用');
      }
    },
    failure(code) {
      setConfirm(false);
      if (code === 'CONFLICT') setConflict(true);
    }
  });
  const resource = useManagementResource<BotManagementSettings>(
    '/api/admin/bot-management/settings?refresh=' + reload,
    { keepPrevious: false, revalidate: !command.locked }
  );
  if (resource.data && !anchor) {
    const normalized = {
      ...resource.data,
      draft: botConfigForEditing(resource.data.publishedConfig ?? resource.data.draft)
    };
    setAnchor(normalized);
    setForm(normalized.draft);
  }
  const data = resource.data ?? anchor,
    config = form,
    dirty = !!anchor && !!config && JSON.stringify(config) !== JSON.stringify(anchor.draft),
    busy = command.locked || testCommand.locked;
  const stale =
    conflict ||
    Boolean(
      anchor &&
      data &&
      (anchor.draftRevision !== data.draftRevision || anchor.publishedVersion !== data.publishedVersion)
    );
  const status =
    data && config
      ? botEditorStatus(
          config,
          data.publishedConfig,
          resource.error ? 'STALE' : data.publicationStatus,
          dirty,
          stale
        )
      : 'STALE';
  const groupResource = useManagementResource<BotGroupList>(
    '/api/admin/bot-management/groups?refresh=' + groupReload,
    { revalidate: !busy }
  );
  const tests = useManagementResource<BotTestStatus & { groupOpenId?: string }>(
    testViewOpened
      ? '/api/admin/bot-management/test-status?refresh=' +
          testReload +
          (lastTestId ? '&id=' + lastTestId : '')
      : null,
    { revalidate: !busy }
  );
  const testStatus = tests.data?.status;
  useEffect(() => {
    if (!testStatus || !['PENDING', 'CLAIMED', 'DISPATCHING'].includes(testStatus) || busy) return;
    const t = setTimeout(() => setTestReload((x) => x + 1), 3000);
    return () => clearTimeout(t);
  }, [testStatus, testReload, busy]);
  const targetOptions = (groupResource.data?.groups ?? []).filter((g) => g.enabled),
    target = targetOptions.find((g) => g.groupOpenId === targetGroup) ?? targetOptions[0];
  const testLabels: Record<string, string> = {
    PENDING: '排队中',
    CLAIMED: '准备发送',
    DISPATCHING: '发送中',
    SENT: '已发送',
    SIMULATED: '模拟完成',
    UNKNOWN: '结果未知',
    DENIED: '发送被拒绝',
    FAILED: '发送失败',
    EXPIRED: '已过期',
    CANCELLED: '已取消'
  };
  const pollingStatus = data?.publicationStatus;
  useEffect(() => {
    if (!pollingStatus || busy) return;
    const timer = setTimeout(
      () => {
        setReload((x) => x + 1);
        setGroupReload((x) => x + 1);
      },
      pollingStatus === 'PENDING' ? 3000 : 30000
    );
    return () => clearTimeout(timer);
  }, [pollingStatus, reload, busy]);
  function change(next: BotEditingConfig) {
    setForm(next);
    setPreview(null);
    command.setError(null);
  }
  function submit(action: 'save' | 'preview') {
    if (!anchor || !config || busy) return;
    void command.submit({
      kind: 'json',
      method: 'POST',
      path: '/api/admin/bot-management/' + action,
      body:
        action === 'preview'
          ? { config, kind: selected }
          : {
              config,
              expectedRevision: anchor.draftRevision,
              expectedVersion: anchor.publishedVersion,
              idempotencyKey: crypto.randomUUID()
            }
    });
  }
  function cancel() {
    if (busy || !anchor) return;
    if (
      stale ||
      (selected.startsWith('reminder:') && !anchor.draft.reminders?.some((r) => r.id === selected.slice(9)))
    )
      setSelected('PUBLISHED');
    setPreview(null);
    setConfirm(false);
    command.setError(null);
    if (stale) {
      setAnchor(null);
      setForm(null);
      setConflict(false);
      setReload((x) => x + 1);
    } else setForm(botConfigForEditing(anchor.draft));
  }
  const reminder = selected.startsWith('reminder:')
    ? config?.reminders?.find((x) => x.id === selected.slice(9))
    : null;
  const template = reminder?.template ?? config?.templates[selected as BotTemplateKind] ?? '';
  function changeTemplate(value: string) {
    if (!config) return;
    if (reminder)
      change({
        ...config,
        reminders: config.reminders?.map((r) => (r.id === reminder.id ? { ...r, template: value } : r))
      });
    else change({ ...config, templates: { ...config.templates, [selected]: value } });
  }
  const baseKind = selected.startsWith('reminder:')
    ? 'REMINDER_2H'
    : (selected as import('@artzoo/domain').BotTemplateKind);
  const variables = botTemplateVariables(baseKind);
  const examples: Record<string, string> = {
    ...botPreviewValues(baseKind),
    ...(reminder ? { event: botReminderLabel(reminder.minutes) } : {})
  };
  if (resource.blocked) return null;
  return (
    <main className="home-content management-content bot-management" id="main-content">
      {contextHolder}
      <div className="management-heading">
        <PageHeading level={1} decoration="burger">
          机器人管理
        </PageHeading>
        <AdminReturnLink />
      </div>
      <CollectionTabs
        tabs={TABS}
        activeKey={tab}
        disabled={busy}
        onTabChange={(key) => {
          setTab(key);
          if (key === 'templates') setTestViewOpened(true);
        }}
      />
      <ErrorNotice
        message={resource.error ?? command.error ?? testCommand.error ?? tests.error ?? groupResource.error}
      />
      {data && config ? (
        <>
          <div className="bot-state">
            <Tag
              variant="solid"
              color={
                status === 'APPLIED'
                  ? token.colorSuccess
                  : status === 'UNSAVED' || status === 'FAILED'
                    ? token.colorError
                    : undefined
              }
            >
              {STATES[status]}
            </Tag>
          </div>
          {tab === 'parameters' ? (
            <ActivityPaper className="management-paper-panel">
              <BotGroupPanel
                data={groupResource.data}
                disabled={busy}
                reload={() => setGroupReload((x) => x + 1)}
              />
              <h2>消息开关</h2>
              <div>
                <label className="bot-switch-row">
                  <span>暂停主动通知</span>
                  <Switch
                    checked={config.proactivePaused}
                    disabled={busy}
                    onChange={(v) => change({ ...config, proactivePaused: v })}
                  />
                </label>
                {BOT_NOTICE_KINDS.filter(
                  (k) => k === 'PUBLISHED' || k === 'CHANGED' || k === 'CANCELLED'
                ).map((k) => (
                  <label className="bot-switch-row" key={k}>
                    <span>{BOT_LABELS[k]}</span>
                    <Switch
                      aria-label={BOT_LABELS[k]}
                      checked={config.notifications[k]}
                      disabled={busy}
                      onChange={(v) =>
                        change({ ...config, notifications: { ...config.notifications, [k]: v } })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="bot-reminder-heading">
                <h2>提前提醒</h2>
                <Button
                  disabled={busy || (config.reminders?.length ?? 0) >= BOT_REMINDER_LIMITS.count}
                  onClick={() => {
                    const used = new Set(config.reminders?.map((r) => r.minutes));
                    const minutes = [30, 15, 180, 240, 10, 5, 1, 360, 720].find((v) => !used.has(v)) ?? 1;
                    change({
                      ...config,
                      reminders: [
                        ...(config.reminders ?? []),
                        {
                          id: crypto.randomUUID(),
                          minutes,
                          enabled: true,
                          template: config.templates.REMINDER_1H
                        }
                      ]
                    });
                  }}
                >
                  添加提醒
                </Button>
              </div>
              <div className="bot-reminders">
                {config.reminders?.map((r, index) => (
                  <div className="bot-reminder-row" key={r.id}>
                    <label className="bot-parameter">
                      <span>提前时长（分钟）</span>
                      <InputNumber
                        aria-label={'提醒' + (index + 1) + '提前分钟'}
                        precision={0}
                        min={BOT_REMINDER_LIMITS.min}
                        max={BOT_REMINDER_LIMITS.max}
                        value={Number.isFinite(r.minutes) ? r.minutes : null}
                        disabled={busy}
                        onChange={(v) =>
                          change({
                            ...config,
                            reminders: config.reminders?.map((x) =>
                              x.id === r.id ? { ...x, minutes: v ?? Number.NaN } : x
                            )
                          })
                        }
                      />
                    </label>
                    <Switch
                      aria-label={'启用提醒' + (index + 1)}
                      checked={r.enabled}
                      disabled={busy}
                      onChange={(enabled) =>
                        change({
                          ...config,
                          reminders: config.reminders?.map((x) => (x.id === r.id ? { ...x, enabled } : x))
                        })
                      }
                    />
                    <Button
                      danger
                      disabled={busy}
                      onClick={() => {
                        change({ ...config, reminders: config.reminders?.filter((x) => x.id !== r.id) });
                        if (selected === 'reminder:' + r.id) setSelected('PUBLISHED');
                      }}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
              <h2>发送参数</h2>
              <div className="bot-parameters">
                {(['proactivePerMinute', 'proactivePerDay', 'passivePerUserMinute'] as const).map((k) => (
                  <label className="bot-parameter" key={k}>
                    <span>{BOT_PARAMETER_RULES[k].label}</span>
                    <InputNumber
                      aria-label={BOT_PARAMETER_RULES[k].label}
                      precision={0}
                      min={BOT_PARAMETER_RULES[k].min}
                      max={BOT_PARAMETER_RULES[k].max}
                      disabled={busy}
                      value={config.parameters[k]}
                      onChange={(v) => change({ ...config, parameters: { ...config.parameters, [k]: v } })}
                    />
                  </label>
                ))}
              </div>
              <details className="bot-advanced">
                <summary>高级参数</summary>
                <div className="bot-parameters">
                  {(['groupPerMinute', 'pollSeconds'] as const).map((k) => (
                    <label className="bot-parameter" key={k}>
                      <span>{BOT_PARAMETER_RULES[k].label}</span>
                      <InputNumber
                        aria-label={BOT_PARAMETER_RULES[k].label}
                        precision={0}
                        min={BOT_PARAMETER_RULES[k].min}
                        max={BOT_PARAMETER_RULES[k].max}
                        disabled={busy}
                        value={config.parameters[k]}
                        onChange={(v) => change({ ...config, parameters: { ...config.parameters, [k]: v } })}
                      />
                    </label>
                  ))}
                </div>
              </details>
            </ActivityPaper>
          ) : null}
          {tab === 'templates' ? (
            <ActivityPaper className="management-paper-panel">
              <div className="bot-template-grid">
                <div className="management-form">
                  <label>
                    消息类别
                    <Select
                      aria-label="消息类别"
                      value={selected}
                      disabled={busy}
                      options={[
                        ...BOT_TEMPLATE_KINDS.filter(
                          (k) => k === 'PUBLISHED' || k === 'CHANGED' || k === 'CANCELLED'
                        ).map((k) => ({ value: k, label: BOT_LABELS[k] })),
                        ...(config.reminders?.length
                          ? [
                              {
                                label: BOT_LABELS.REMINDER,
                                options: config.reminders.map((r) => ({
                                  value: 'reminder:' + r.id,
                                  label: botReminderLabel(r.minutes)
                                }))
                              }
                            ]
                          : [])
                      ]}
                      onChange={(k) => {
                        setSelected(k);
                        setPreview(null);
                      }}
                    />
                  </label>
                  <label htmlFor="bot-message-template">
                    正文
                    <Input.TextArea
                      id="bot-message-template"
                      rows={9}
                      maxLength={300}
                      value={template}
                      disabled={busy}
                      onChange={(e) => changeTemplate(e.target.value)}
                    />
                  </label>
                  <div className="bot-variables">
                    <h3>变量与预览值</h3>
                    {Object.entries(variables).map(([key, label]) => (
                      <div className="bot-variable" key={key}>
                        <Button
                          size="small"
                          disabled={
                            busy ||
                            template.includes('{' + label + '}') ||
                            template.length + label.length + 2 > 300
                          }
                          onClick={() => changeTemplate(template + '{' + label + '}')}
                        >
                          {'{' + label + '}'}
                        </Button>
                        <span>{examples[key]}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bot-preview">
                  <div className="bot-preview-heading">
                    <h2>消息预览</h2>
                    <div className="bot-preview-actions">
                      <Button disabled={busy} onClick={() => submit('preview')}>
                        预览
                      </Button>
                      <Button
                        disabled={
                          testCommand.busy ||
                          command.locked ||
                          (!testCommand.unknown && (!target || data.publicationStatus !== 'APPLIED'))
                        }
                        onClick={() => {
                          if (testCommand.unknown) void testCommand.retry();
                          else setTestConfirm(true);
                        }}
                      >
                        {testCommand.unknown ? '确认测试结果' : '发送测试消息'}
                      </Button>
                      <Button
                        disabled={
                          busy ||
                          probeUsed ||
                          !data.buttonProbe?.available ||
                          data.publicationStatus !== 'APPLIED'
                        }
                        title={data.buttonProbe?.used ? '本轮按钮测试已经申请' : '只在批准的限时窗口内可用'}
                        onClick={() => setProbeConfirm(true)}
                      >
                        按钮预填测试
                      </Button>
                    </div>
                  </div>
                  {preview ? <pre aria-live="polite">{preview}</pre> : null}
                  {tests.data ? (
                    <p role="status">
                      测试消息：{testLabels[tests.data.status] ?? '结果待确认'}
                      {tests.data.groupOpenId
                        ? ' · ' +
                          (groupResource.data?.groups.find((g) => g.groupOpenId === tests.data?.groupOpenId)
                            ?.label ?? '所选群')
                        : ''}
                    </p>
                  ) : null}
                </div>
              </div>
            </ActivityPaper>
          ) : null}
          <div className="management-actions">
            <Button disabled={busy || (!dirty && !stale)} onClick={cancel}>
              取消
            </Button>
            <Button
              type="primary"
              loading={command.busy}
              disabled={command.busy || stale || (!command.unknown && (!data.scope || status === 'APPLIED'))}
              onClick={() => {
                if (command.unknown) void command.retry();
                else setConfirm(true);
              }}
            >
              {command.unknown ? '确认保存结果' : '保存并生效'}
            </Button>
          </div>
          <Modal
            title="发送一条按钮预填测试消息？"
            open={probeConfirm}
            onCancel={() => {
              if (!busy) setProbeConfirm(false);
            }}
            onOk={() => {
              if (!anchor || !data?.scope || busy) return;
              void testCommand.submit({
                kind: 'json',
                method: 'POST',
                path: '/api/admin/bot-management/test',
                body: {
                  kind: 'BUTTON_PREFILL_PROBE',
                  targetGroupOpenId: data.scope.groupOpenId,
                  expectedRevision: anchor.draftRevision,
                  expectedVersion: anchor.publishedVersion,
                  idempotencyKey: crypto.randomUUID()
                }
              });
            }}
            confirmLoading={testCommand.busy}
            okText="确认发送一条"
            cancelText="取消"
            closable={!busy}
            mask={{ closable: !busy }}
          >
            <p>
              目标：当前主绑定群（
              {groupResource.data?.groups.find((g) => g.groupOpenId === data?.scope?.groupOpenId)?.label ??
                '已绑定测试群'}
              ）。
            </p>
            <p>
              只发送一条固定测试消息，按钮仅预填“报名 测试编号 MT 骑士”，不会自动发送；该示例指令无法报名。
            </p>
            <pre style={{ whiteSpace: 'pre-wrap' }}>
              【按钮预填测试，不会报名】{'\n'}点击“填写报名（测试）”仅把示例指令放入输入框。{'\n'}
              请勿发送，检查后清空即可。{'\n'}示例指令：报名 测试编号 MT 骑士。{'\n'}
              “测试编号”不可用于任何活动报名。
            </pre>
          </Modal>
          <Modal
            title="发送测试消息？"
            open={testConfirm}
            onCancel={() => {
              if (!busy) setTestConfirm(false);
            }}
            onOk={() => {
              if (!anchor || !config || !target || busy) return;
              void testCommand.submit({
                kind: 'json',
                method: 'POST',
                path: '/api/admin/bot-management/test',
                body: {
                  config,
                  kind: selected,
                  targetGroupOpenId: target.groupOpenId,
                  expectedRevision: anchor.draftRevision,
                  expectedVersion: anchor.publishedVersion,
                  idempotencyKey: crypto.randomUUID()
                }
              });
            }}
            confirmLoading={testCommand.busy}
            okText="确认发送"
            cancelText="取消"
            closable={!busy}
            mask={{ closable: !busy }}
          >
            <label>
              目标群
              <Select
                aria-label="测试消息目标群"
                value={target?.groupOpenId}
                disabled={busy}
                options={targetOptions.map((g) => ({ value: g.groupOpenId, label: g.label }))}
                onChange={setTargetGroup}
              />
            </label>
            <p>
              {target?.label} · {target?.groupOpenId.slice(-8)}
            </p>
            <p>使用当前编辑模板和虚拟数据，发送一条测试消息；不保存配置，不用于报名。</p>
          </Modal>
          <Modal
            title="保存并生效？"
            open={confirm}
            onCancel={() => {
              if (!busy) setConfirm(false);
            }}
            onOk={() => submit('save')}
            confirmLoading={command.busy}
            cancelButtonProps={{ disabled: busy }}
            okText="确认保存"
            cancelText="取消"
            closable={!busy}
            mask={{ closable: !busy }}
          >
            <p>保存当前参数和消息模板。</p>
          </Modal>
        </>
      ) : resource.loading ? (
        <p role="status">正在读取配置…</p>
      ) : null}
    </main>
  );
}
