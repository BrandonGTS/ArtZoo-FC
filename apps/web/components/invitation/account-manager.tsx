'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Modal, Select, Table, type TableProps } from 'antd';
import {
  canChangeAccountMembership,
  type AccountSummary,
  type AuditSummary,
  type Membership
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { applyFieldErrors, ErrorNotice, membershipLabels, membershipOptions } from '../account/account-ui';
import { useAuthSession } from '../auth-session';
import { beijingTime, useAdminList } from './use-admin-list';
import { useAdminPage } from './use-admin-page';
import styles from './admin.module.css';
import { ActivityPaper } from '../activities/activity-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { CollectionSearch, ListPagination } from '../collection-controls';
import { ManagementTable } from '../admin-management/management-audits';
import '../admin-management/admin-management.css';

export default function AccountManager({ onLocked }: { onLocked?(locked: boolean): void } = {}) {
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<AccountSummary | null>(null);
  useEffect(() => {
    onLocked?.(Boolean(selected));
    return () => onLocked?.(false);
  }, [selected, onLocked]);
  const { notify, contextHolder } = useFeedbackMessage();
  const { session, refresh } = useAuthSession();
  const list = useAdminList<AccountSummary>(
    `/api/admin/accounts?limit=20&query=${encodeURIComponent(query)}`,
    !!query
  );
  const audit = useAdminPage<AuditSummary>('/api/admin/audit?scope=membership');
  const columns: TableProps<AccountSummary>['columns'] = [
    { title: '游戏昵称', dataIndex: 'displayName', render: (value) => value || '未填写游戏昵称' },
    { title: '大区 / 服务器', key: 'gameLocation', render: (_, item) => gameLocationLabel(item) },
    { title: '手机号', dataIndex: 'phoneMasked' },
    { title: '参与身份', dataIndex: 'membership', render: (value: Membership) => membershipLabels[value] },
    {
      title: '管理职责',
      dataIndex: 'adminRole',
      render: (value: AccountSummary['adminRole']) =>
        ({ NONE: '无', ADMIN: '管理员', SUPER_ADMIN: '超级管理员' })[value]
    },
    {
      title: '操作',
      key: 'action',
      render: (_, item) => (
        <Button
          type="link"
          disabled={!canChangeAccountMembership(session?.user, item)}
          onClick={() => setSelected(item)}
        >
          调整身份
        </Button>
      )
    }
  ];
  return (
    <>
      {contextHolder}
      <ActivityPaper className="management-panel management-paper-panel">
        <h2 id="account-list-title">身份维护</h2>
        <p className={styles.description}>
          调整正式成员／朋友身份。已有报名保留，后续操作按当前身份判断；管理职责保持不变。
        </p>
        <div className="management-search">
          <CollectionSearch
            id="membership-account-query"
            searchLabel="按游戏昵称搜索"
            placeholder="输入游戏昵称"
            query={searchInput}
            onQueryChange={(value) => {
              setSearchInput(value);
              if (!value.trim()) {
                setQuery('');
              }
            }}
            onClear={() => {
              setSearchInput('');
              setQuery('');
            }}
            onSearch={(value) => {
              const nextQuery = value.trim();
              setQuery(nextQuery);
              if (nextQuery) list.reload();
            }}
          />
        </div>
        <ErrorNotice message={list.error} />
        <ManagementTable>
          <Table<AccountSummary>
            rowKey="id"
            dataSource={list.items}
            columns={columns}
            loading={list.loading}
            pagination={false}
            scroll={{ x: 850 }}
            locale={{
              emptyText: !query
                ? '输入游戏昵称并点击查询'
                : list.error
                  ? '账号列表暂不可用'
                  : '暂无符合条件的账号'
            }}
          />
        </ManagementTable>
        {list.nextCursor ? (
          <Button className={styles.more} onClick={list.more} loading={list.loading}>
            加载更多
          </Button>
        ) : null}
      </ActivityPaper>
      <ActivityPaper className="management-panel management-paper-panel">
        <h2 id="audit-title">身份调整记录</h2>
        <ErrorNotice message={audit.error} />
        <ManagementTable>
          <Table<AuditSummary>
            className={styles.table}
            rowKey="id"
            dataSource={audit.items}
            loading={audit.loading}
            pagination={false}
            scroll={{ x: 800 }}
            locale={{ emptyText: audit.error ? '身份调整记录暂不可用' : '暂无身份调整记录' }}
            columns={[
              { title: '时间（北京时间）', dataIndex: 'createdAt', render: beijingTime },
              {
                title: '操作人',
                key: 'actor',
                render: (_, item) => item.actor.displayName || item.actor.phoneMasked
              },
              { title: '操作', dataIndex: 'action', render: () => '调整参与身份' },
              {
                title: '身份变化',
                key: 'membership',
                render: (_, item) =>
                  item.beforeMembership && item.afterMembership
                    ? `${membershipLabels[item.beforeMembership]} → ${membershipLabels[item.afterMembership]}`
                    : '—'
              },
              { title: '原因', dataIndex: 'reason', render: (value) => value || '—' }
            ]}
            expandable={{ expandedRowRender: (item) => <p>对象编号：{item.targetAccountId || '—'}</p> }}
          />
        </ManagementTable>
        <ListPagination
          page={audit.page}
          totalPages={Math.ceil(audit.total / audit.pageSize)}
          loading={audit.loading}
          onPageChange={audit.changePage}
          label="身份调整记录分页"
        />
      </ActivityPaper>
      {selected && canChangeAccountMembership(session?.user, selected) ? (
        <MembershipDialog
          account={selected}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null);
            notify('success', '参与身份已更新。');
            list.reload();
            audit.reload();
            await refresh().catch(() => {});
          }}
          onConflict={() => list.reload()}
        />
      ) : null}
    </>
  );
}
function gameLocationLabel(account: AccountSummary) {
  return account.gameRegion && account.gameServer
    ? `${account.gameRegion} / ${account.gameServer}`
    : '未填写服务器';
}
function MembershipDialog({
  account,
  onClose,
  onSaved,
  onConflict
}: {
  account: AccountSummary;
  onClose(): void;
  onSaved(): Promise<void>;
  onConflict(): void;
}) {
  const [form] = Form.useForm<{ membership: Membership; reason: string }>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const { notify, contextHolder } = useFeedbackMessage();
  const lock = useRef(false);
  async function submit(values: { membership: Membership; reason: string }) {
    if (lock.current || conflict) return;
    lock.current = true;
    setBusy(true);
    try {
      await accountRequest(`/api/admin/accounts/${encodeURIComponent(account.id)}/membership`, {
        method: 'PATCH',
        body: {
          membership: values.membership,
          reason: values.reason.trim(),
          expectedMembership: account.membership
        }
      });
      await onSaved();
    } catch (error) {
      const detail = errorDetail(error);
      notify('error', detail.message);
      applyFieldErrors(form, detail);
      if (detail.code === 'CONFLICT') {
        setConflict(true);
        onConflict();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="调整参与身份"
      footer={null}
      onCancel={onClose}
      closable={{ disabled: busy }}
      keyboard={!busy}
      mask={{ closable: false }}
      destroyOnHidden
    >
      {contextHolder}
      <p className={styles.description}>
        {account.displayName || '未填写游戏昵称'} · {gameLocationLabel(account)} · {account.phoneMasked} ·
        当前为{membershipLabels[account.membership]}
      </p>
      <Form
        autoComplete="off"
        form={form}
        name="membership-change"
        layout="vertical"
        onFinish={submit}
        disabled={busy || conflict}
        initialValues={{ membership: account.membership === 'MEMBER' ? 'FRIEND' : 'MEMBER' }}
        clearOnDestroy
      >
        <Form.Item
          label="调整为"
          name="membership"
          rules={[
            { required: true, message: '请选择身份' },
            {
              validator(_, value) {
                return value !== account.membership
                  ? Promise.resolve()
                  : Promise.reject(new Error('请选择不同于当前的身份'));
              }
            }
          ]}
        >
          <Select options={membershipOptions} />
        </Form.Item>
        <Form.Item
          label="调整原因"
          name="reason"
          rules={[
            { required: true, whitespace: true, message: '请填写调整原因' },
            { max: 1000, message: '原因最多1000字' }
          ]}
        >
          <Input.TextArea autoComplete="off" rows={3} maxLength={1000} />
        </Form.Item>
        {conflict ? (
          <p className={styles.description}>
            该账号已被其他管理员修改，请关闭窗口并根据列表中的最新身份重新操作。
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button htmlType="submit" type="primary" loading={busy} disabled={conflict}>
            确认调整
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
