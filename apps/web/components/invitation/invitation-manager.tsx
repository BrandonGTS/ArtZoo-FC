'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  type DatePickerProps,
  type TableProps
} from 'antd';
import { beijingPickerTimestamp } from '../beijing-picker';
import type { InvitationSummary, InvitationUsageMode, Membership } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { applyFieldErrors, ErrorNotice, membershipLabels, membershipOptions } from '../account/account-ui';
import { beijingTime, useAdminList } from './use-admin-list';
import styles from './admin.module.css';
import { ActivityPaper } from '../activities/activity-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { ManagementTable } from '../admin-management/management-audits';
import '../admin-management/admin-management.css';

type CreateValues = {
  membership: Membership;
  usageMode: InvitationUsageMode;
  expiresAt: Exclude<NonNullable<DatePickerProps['value']>, unknown[]>;
};
const statusLabels = { ACTIVE: '待使用', USED: '已使用', REVOKED: '已失效', EXPIRED: '已过期' };
function expiryIso(value: CreateValues['expiresAt']) {
  return new Date(beijingPickerTimestamp(value.format('YYYY-MM-DDTHH:mm:ss'))).toISOString();
}

export default function InvitationManager() {
  const list = useAdminList<InvitationSummary>('/api/admin/invitations?limit=20');
  const [form] = Form.useForm<CreateValues>();
  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const { notify, contextHolder } = useFeedbackMessage();
  const [copyError, setCopyError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [selected, setSelected] = useState<InvitationSummary | null>(null);
  async function create(values: CreateValues) {
    if (createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setCopyError(null);
    try {
      const result = await accountRequest<{ invitation: InvitationSummary; invitePath: string }>(
        '/api/admin/invitations',
        {
          method: 'POST',
          body: {
            membership: values.membership,
            usageMode: values.usageMode,
            expiresAt: expiryIso(values.expiresAt)
          }
        }
      );
      // The browser holds plaintext only in component memory; the server stores authenticated ciphertext.
      if (!/^\/invite\/[^/?#]+$/.test(result.invitePath)) throw new Error('Invalid invitation path');
      setCreated({ id: result.invitation.id, url: window.location.origin + result.invitePath });
      notify('success', '邀请已创建。');
      list.reload();
    } catch (error) {
      const detail = errorDetail(error);
      notify('error', detail.message);
      applyFieldErrors(form, detail);
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }
  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopyError(null);
      notify('success', '邀请链接已复制。');
    } catch {
      setCopyError('无法自动复制，请选中链接后复制。');
    }
  }
  const columns: TableProps<InvitationSummary>['columns'] = [
    { title: '受邀身份', dataIndex: 'membership', render: (value: Membership) => membershipLabels[value] },
    {
      title: '使用方式',
      dataIndex: 'usageMode',
      render: (value: InvitationUsageMode) => (value === 'MULTIPLE' ? '多次' : '单次')
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: InvitationSummary['status'], item) => (
        <Tag>{value === 'ACTIVE' && item.usageMode === 'MULTIPLE' ? '有效' : statusLabels[value]}</Tag>
      )
    },
    { title: '有效至（北京时间）', dataIndex: 'expiresAt', render: beijingTime },
    { title: '创建时间', dataIndex: 'createdAt', render: beijingTime },
    {
      title: '操作',
      key: 'action',
      render: (_, item) => (
        <Button type="link" danger onClick={() => setSelected(item)}>
          移除
        </Button>
      )
    }
  ];
  return (
    <div className={styles.columns}>
      {contextHolder}
      <ActivityPaper className="management-panel management-paper-panel">
        <h2 id="create-invitation-title">创建邀请</h2>
        <p className={styles.description}>受邀人注册后获得指定身份。</p>
        <Form
          autoComplete="off"
          form={form}
          name="create-invitation"
          layout="vertical"
          onFinish={create}
          disabled={creating}
          initialValues={{ membership: 'FRIEND', usageMode: 'SINGLE' }}
        >
          <Form.Item
            name="membership"
            label="受邀身份"
            rules={[{ required: true, message: '请选择受邀身份' }]}
          >
            <Select options={membershipOptions} />
          </Form.Item>
          <Form.Item
            name="usageMode"
            label="使用方式"
            rules={[{ required: true, message: '请选择使用方式' }]}
          >
            <Select
              options={[
                { value: 'SINGLE', label: '单次' },
                { value: 'MULTIPLE', label: '多次' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="expiresAt"
            label="有效至（北京时间）"
            rules={[
              { required: true, message: '请选择有效期' },
              {
                validator(_, value) {
                  if (!value) return Promise.resolve();
                  return new Date(expiryIso(value)).getTime() > Date.now()
                    ? Promise.resolve()
                    : Promise.reject(new Error('有效期须晚于当前时间'));
                }
              }
            ]}
          >
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              className={styles.date}
              placeholder="选择日期和时间"
            />
          </Form.Item>
          <Button block type="primary" htmlType="submit" loading={creating}>
            创建邀请
          </Button>
        </Form>
        {copyError ? (
          <p role="status" className={styles.status}>
            {copyError}
          </p>
        ) : null}
        {created ? (
          <div className={styles.linkResult}>
            <p className={styles.description}>请妥善交给受邀人。有效邀请可在下方展开记录，再次复制链接。</p>
            <Input.TextArea
              autoComplete="off"
              aria-label="新邀请链接"
              readOnly
              value={created.url}
              autoSize={{ minRows: 2, maxRows: 4 }}
              onFocus={(event) => event.target.select()}
            />
            <Button onClick={copy}>复制邀请链接</Button>
          </div>
        ) : null}
      </ActivityPaper>
      <ActivityPaper className="management-panel management-paper-panel">
        <h2 id="invitation-list-title">邀请记录</h2>
        <ErrorNotice message={list.error} />
        <ManagementTable>
          <Table<InvitationSummary>
            className={styles.table}
            rowKey="id"
            columns={columns}
            dataSource={list.items}
            loading={list.loading}
            pagination={false}
            scroll={{ x: 670 }}
            locale={{ emptyText: list.error ? '邀请记录暂不可用' : '暂无邀请记录' }}
            expandable={{
              expandedRowKeys: expandedKeys,
              onExpandedRowsChange: (keys) => setExpandedKeys([...keys]),
              expandedRowRender: (item) => (
                <div>
                  <p>创建人：{item.createdBy.displayName || '未填写游戏昵称'}</p>
                  {expandedKeys.includes(item.id) ? <InvitationLink key={item.id} invitation={item} /> : null}
                  <p>使用时间：{beijingTime(item.usedAt)}</p>
                  <p>原撤销时间：{beijingTime(item.revokedAt)}</p>
                </div>
              )
            }}
          />
        </ManagementTable>
        {list.nextCursor ? (
          <Button className={styles.more} onClick={list.more} loading={list.loading}>
            加载更多
          </Button>
        ) : null}
      </ActivityPaper>
      {selected ? (
        <RemoveDialog
          invitation={selected}
          onClose={() => setSelected(null)}
          onRemoved={(item) => {
            if (created?.id === item.id) setCreated(null);
            setSelected(null);
            notify('success', '邀请已移除。');
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}
function RemoveDialog({
  invitation,
  onClose,
  onRemoved
}: {
  invitation: InvitationSummary;
  onClose(): void;
  onRemoved(item: InvitationSummary): void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { notify, contextHolder } = useFeedbackMessage();
  async function submit(values: { reason: string }) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<{ removed: true }>(
        `/api/admin/invitations/${encodeURIComponent(invitation.id)}/remove`,
        { method: 'POST', body: { reason: values.reason.trim() } }
      );
      if (result.removed) onRemoved(invitation);
    } catch (error) {
      const detail = errorDetail(error);
      notify('error', detail.message);
      applyFieldErrors(form, detail);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="移除这份邀请？"
      footer={null}
      onCancel={onClose}
      closable={{ disabled: busy }}
      keyboard={!busy}
      mask={{ closable: false }}
      destroyOnHidden
    >
      {contextHolder}
      <p className={styles.description}>
        {membershipLabels[invitation.membership]} · 有效至 {beijingTime(invitation.expiresAt)}
        。移除后，邀请立即失效并从列表隐藏；已注册账号不受影响，操作记录会保留。
      </p>
      <Form
        autoComplete="off"
        form={form}
        name="remove-invitation"
        layout="vertical"
        onFinish={submit}
        disabled={busy}
        clearOnDestroy
      >
        <Form.Item
          name="reason"
          label="移除原因"
          rules={[
            { required: true, whitespace: true, message: '请填写移除原因' },
            { max: 1000, message: '原因最多1000字' }
          ]}
        >
          <Input.TextArea autoComplete="off" rows={3} maxLength={1000} />
        </Form.Item>
        <div className={styles.actions}>
          <Button disabled={busy} onClick={onClose}>
            保留邀请
          </Button>
          <Button danger htmlType="submit" loading={busy}>
            确认移除
          </Button>
        </div>
      </Form>
    </Modal>
  );
}

function InvitationLink({ invitation }: { invitation: InvitationSummary }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  const { notify, contextHolder } = useFeedbackMessage();
  useEffect(() => {
    if (!invitation.linkAvailable || invitation.status !== 'ACTIVE') return;
    const controller = new AbortController();
    accountRequest<{ invitePath: string }>(
      `/api/admin/invitations/${encodeURIComponent(invitation.id)}/link`,
      { method: 'POST', body: {}, signal: controller.signal }
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!/^\/invite\/[A-Za-z0-9_-]{43}$/.test(data.invitePath))
          throw new Error('Invalid invitation path');
        setState({ url: window.location.origin + data.invitePath });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ error: errorDetail(error).message });
      });
    return () => controller.abort();
  }, [invitation.id, invitation.linkAvailable, invitation.status]);
  async function copy() {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setState((value) => ({ ...value, error: undefined }));
      notify('success', '邀请链接已复制。');
    } catch {
      setState((value) => ({ ...value, error: '无法自动复制，请选中链接后复制。' }));
    }
  }
  if (invitation.status !== 'ACTIVE') return <p>此邀请已失效，无法复制链接。</p>;
  if (!invitation.linkAvailable) return <p>邀请链接暂不可用，请检查服务配置。</p>;
  return (
    <div className={styles.linkResult}>
      {contextHolder}
      {state.url ? (
        <>
          <Input.TextArea
            autoComplete="off"
            aria-label="邀请链接"
            readOnly
            value={state.url}
            autoSize={{ minRows: 2, maxRows: 4 }}
            onFocus={(event) => event.target.select()}
          />
          <Button onClick={copy}>复制邀请链接</Button>
        </>
      ) : state.error ? null : (
        <p role="status">正在读取邀请链接…</p>
      )}
      <ErrorNotice message={state.error || null} />
    </div>
  );
}
