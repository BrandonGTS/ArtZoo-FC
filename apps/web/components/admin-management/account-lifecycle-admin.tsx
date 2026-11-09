'use client';
import { AdminReturnLink } from '../admin-return-link';

import { useEffect, useState } from 'react';
import { Button, Input, Modal, Table } from 'antd';
import type {
  LifecycleAccount,
  LifecycleAudit,
  LifecycleImpact,
  LifecyclePreview,
  NumberedPageResult
} from '@artzoo/domain';
import { ActivityPaper } from '../activities/activity-ui';
import { PageHeading } from '../page-heading';
import { ErrorNotice } from '../account/account-ui';
import { beijingFull } from '../activities/activity-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { SuperAdminOnly, useSuperAdminScope } from './super-admin-scope';
import { useManagementCommand, useManagementResource } from './management-api';
import { ManagementTable, roleLabels } from './management-audits';
import { CollectionSearch, ListPagination } from '../collection-controls';
import './admin-management.css';
import './account-lifecycle.css';

type Selection = { account: LifecycleAccount; active: boolean };
type LifecycleResult = { account: LifecycleAccount; replayed: boolean; auditId: string };

export default function AccountLifecycleAdmin() {
  return (
    <SuperAdminOnly>
      <OwnedLifecycleAdmin />
    </SuperAdminOnly>
  );
}

function OwnedLifecycleAdmin() {
  const { actorId } = useSuperAdminScope();
  const { notify, contextHolder } = useFeedbackMessage();
  const [draft, setDraft] = useState(''),
    [query, setQuery] = useState('');
  const [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null),
    [locked, setLocked] = useState(false);
  const list = useManagementResource<NumberedPageResult<LifecycleAccount>>(
    query
      ? '/api/admin/account-lifecycle/accounts?query=' +
          encodeURIComponent(query) +
          '&page=' +
          page +
          '&pageSize=20&refresh=' +
          refresh
      : null,
    { keepPrevious: true, revalidate: !locked }
  );
  if (!list.loading && list.data && page > Math.max(1, Math.ceil(list.data.total / 20)))
    setPage(Math.max(1, Math.ceil(list.data.total / 20)));
  if (list.blocked) return null;
  return (
    <main className="home-content management-content account-lifecycle-content" id="main-content">
      {contextHolder}
      <div className="management-heading">
        <PageHeading level={1} decoration="burger">
          账号停用与恢复
        </PageHeading>
        <AdminReturnLink disabled={locked} />
      </div>
      <ActivityPaper className="management-panel management-paper-panel">
        <div className="management-search">
          <CollectionSearch
            id="lifecycle-account-query"
            searchLabel="搜索账号"
            placeholder="搜索成员或朋友"
            query={draft}
            disabled={locked || Boolean(selection)}
            onQueryChange={setDraft}
            onSearch={(value) => {
              setQuery(value.trim());
              setPage(1);
            }}
            onClear={() => {
              setDraft('');
              setQuery('');
              setPage(1);
            }}
          />
        </div>
        <div className="management-error">
          <ErrorNotice message={list.error} />
          {list.error ? (
            <Button disabled={locked} onClick={() => setRefresh((value) => value + 1)}>
              重试读取
            </Button>
          ) : null}
        </div>
        <ManagementTable>
          <Table<LifecycleAccount>
            rowKey="id"
            loading={list.loading}
            dataSource={list.data?.items ?? []}
            pagination={false}
            scroll={{ x: 680 }}
            locale={{ emptyText: query ? '没有找到账号' : '请输入搜索内容' }}
            columns={[
              {
                title: '成员',
                key: 'account',
                render: (_, account) => (
                  <div>
                    {account.displayName || '成员'}
                    <p className="management-meta">{account.phoneMasked}</p>
                  </div>
                )
              },
              {
                title: '身份',
                key: 'membership',
                render: (_, account) => (account.membership === 'MEMBER' ? '正式成员' : '朋友')
              },
              { title: '管理员资格', key: 'role', render: (_, account) => roleLabels[account.adminRole] },
              {
                title: '账号状态',
                key: 'status',
                render: (_, account) => (account.active ? '正常' : '已停用')
              },
              {
                title: '操作',
                key: 'action',
                render: (_, account) => (
                  <Button
                    className={account.active ? 'management-warning-button' : undefined}
                    disabled={
                      locked ||
                      list.loading ||
                      Boolean(selection) ||
                      account.id === actorId ||
                      account.adminRole === 'SUPER_ADMIN'
                    }
                    onClick={() => {
                      if (account.id !== actorId && account.adminRole !== 'SUPER_ADMIN')
                        setSelection({ account, active: !account.active });
                    }}
                  >
                    {account.active ? '停用账号' : '恢复账号'}
                  </Button>
                )
              }
            ]}
          />
        </ManagementTable>
        {list.data ? (
          <ListPagination
            page={page}
            totalPages={Math.ceil(list.data.total / 20)}
            loading={list.loading || locked || Boolean(selection)}
            onPageChange={setPage}
            label="账号列表分页"
          />
        ) : null}
        <LifecycleAudits refresh={refresh} disabled={locked} />
      </ActivityPaper>
      {selection ? (
        <LifecycleConfirmation
          key={selection.account.id + ':' + selection.active}
          selection={selection}
          remote={list.data?.items.find((account) => account.id === selection.account.id) ?? null}
          onLocked={setLocked}
          onCancel={() => setSelection(null)}
          onSaved={(result) => {
            notify(
              'success',
              result.replayed ? '操作结果已确认' : result.account.active ? '账号已恢复' : '账号已停用'
            );
            setSelection(null);
            setLocked(false);
            setRefresh((value) => value + 1);
          }}
        />
      ) : null}
    </main>
  );
}

function LifecycleConfirmation({
  selection,
  remote,
  onLocked,
  onCancel,
  onSaved
}: {
  selection: Selection;
  remote: LifecycleAccount | null;
  onLocked(locked: boolean): void;
  onCancel(): void;
  onSaved(result: LifecycleResult): void;
}) {
  const { actorId } = useSuperAdminScope();
  const { notify, contextHolder } = useFeedbackMessage();
  const [reason, setReason] = useState(''),
    [refresh, setRefresh] = useState(0),
    [confirming, setConfirming] = useState(false);
  const [conflicted, setConflicted] = useState(false),
    [knownRevision, setKnownRevision] = useState(selection.account.lifecycleRevision);
  const [accepted, setAccepted] = useState<{ path: string; preview: LifecyclePreview } | null>(null);
  const command = useManagementCommand<LifecycleResult>({
    success(result) {
      if (
        result?.account?.id !== selection.account.id ||
        typeof result.account.active !== 'boolean' ||
        typeof result.account.lifecycleRevision !== 'number' ||
        !result.auditId
      )
        throw new Error('Invalid response');
      onSaved(result);
    },
    failure(code) {
      if (code === 'CONFLICT') setConflicted(true);
    }
  });
  const path =
    '/api/admin/account-lifecycle/accounts/' +
    selection.account.id +
    '/preview?active=' +
    (selection.active ? '1' : '0') +
    '&refresh=' +
    refresh;
  const resource = useManagementResource<LifecyclePreview>(path, { revalidate: false });
  const incoming = resource.data;
  const validIncoming =
    incoming?.account?.id === selection.account.id &&
    incoming.active === selection.active &&
    typeof incoming.account.lifecycleRevision === 'number' &&
    Boolean(incoming.previewFingerprint) &&
    Boolean(incoming.impact);
  if (incoming && validIncoming && (accepted?.path !== path || accepted.preview !== incoming)) {
    setAccepted({ path, preview: incoming });
    setConflicted(false);
    setConfirming(false);
    if (incoming.account.lifecycleRevision > knownRevision)
      setKnownRevision(incoming.account.lifecycleRevision);
  }
  if (remote && remote.lifecycleRevision > knownRevision) setKnownRevision(remote.lifecycleRevision);
  const preview = accepted?.preview ?? null;
  const account = preview?.account ?? selection.account;
  const protectedTarget =
    account.id === actorId || account.adminRole === 'SUPER_ADMIN' || remote?.adminRole === 'SUPER_ADMIN';
  const stale =
    conflicted ||
    Boolean(
      preview &&
      (knownRevision > preview.account.lifecycleRevision ||
        (remote && remote.active !== preview.account.active))
    );
  const ready = Boolean(
    preview && accepted?.path === path && !resource.loading && !resource.error && !stale && !protectedTarget
  );
  useEffect(() => {
    onLocked(command.locked);
    return () => onLocked(false);
  }, [command.locked, onLocked]);
  useEffect(() => {
    if (command.error && !command.unknown) notify('error', command.error);
  }, [command.error, command.unknown, notify]);
  function close() {
    if (!command.locked) onCancel();
  }
  function reread() {
    if (!command.locked) {
      setConfirming(false);
      command.setError(null);
      setRefresh((value) => value + 1);
    }
  }
  function continueConfirmation() {
    if (!ready || command.locked) return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    command.setError(null);
    setConfirming(true);
  }
  async function confirm() {
    if (!ready || !preview || !confirming || command.locked) return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    await command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/admin/account-lifecycle/accounts/' + account.id,
      body: {
        active: selection.active,
        expectedRevision: preview.account.lifecycleRevision,
        previewFingerprint: preview.previewFingerprint,
        confirmed: true,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID()
      }
    });
  }
  if (resource.blocked) return null;
  return (
    <Modal
      title={selection.active ? '恢复账号' : '停用账号'}
      open
      width={720}
      className="account-lifecycle-modal"
      onCancel={close}
      closable={!command.locked}
      keyboard={!command.locked}
      mask={{ closable: !command.locked }}
      footer={
        command.unknown ? (
          <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
            重试确认操作
          </Button>
        ) : (
          <>
            <Button disabled={command.locked} onClick={close}>
              取消
            </Button>
            {stale || resource.error || (incoming && !validIncoming) ? (
              <Button
                disabled={command.locked || resource.loading}
                loading={resource.loading}
                onClick={reread}
              >
                重新读取影响
              </Button>
            ) : confirming ? (
              <>
                <Button disabled={command.locked} onClick={() => setConfirming(false)}>
                  返回修改
                </Button>
                <Button
                  type="primary"
                  className={
                    !selection.active ? 'management-warning-button management-warning-primary' : undefined
                  }
                  disabled={!ready || command.locked}
                  loading={command.busy}
                  onClick={() => void confirm()}
                >
                  {selection.active ? '确认恢复' : '确认停用'}
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                className={
                  !selection.active ? 'management-warning-button management-warning-primary' : undefined
                }
                disabled={!ready || command.locked}
                loading={resource.loading}
                onClick={continueConfirmation}
              >
                继续确认
              </Button>
            )}
          </>
        )
      }
    >
      {contextHolder}
      <div className="account-lifecycle-confirm">
        <p className="management-role-target">
          {account.displayName || '成员'} · {account.phoneMasked}
        </p>
        <p>
          {selection.active
            ? '恢复后可再次登录。此前终止的活动、报名和队伍关系不会自动恢复。'
            : '停用后将无法登录，现有登录会话将失效。历史内容与积分保留。'}
        </p>
        {protectedTarget ? <ErrorNotice message="不能停用或恢复自己及超级管理员账号。" /> : null}
        {resource.loading ? <p role="status">正在读取影响…</p> : null}
        <ErrorNotice
          message={resource.error || (incoming && !validIncoming ? '影响预览无效，请重新读取。' : null)}
        />
        {preview ? (
          <>
            <p className="management-meta">影响清单 · {beijingFull(preview.serverNow)}</p>
            <LifecycleImpactList impact={preview.impact} />
          </>
        ) : null}
        {stale ? (
          <ErrorNotice message="账号或关联事项已变化，请重新读取影响后再确认。已填写的原因会保留。" />
        ) : null}
        <label className="management-role-form" htmlFor="lifecycle-reason">
          操作原因
          <Input.TextArea
            autoComplete="off"
            id="lifecycle-reason"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={command.locked || confirming || protectedTarget}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {confirming ? (
          <p className="account-lifecycle-final">
            {selection.active
              ? '确认恢复该账号？此前终止的关联事项不会自动恢复。'
              : '确认停用该账号并处理以上事项？'}
          </p>
        ) : null}
        <ErrorNotice message={command.error} />
      </div>
    </Modal>
  );
}

function LifecycleImpactList({ impact }: { impact: LifecycleImpact }) {
  const groups = [
    {
      key: 'activities',
      title: '活动',
      rows: impact.activities.map((item) => ({
        id: item.id,
        text: item.title,
        detail: timeRange(item.startsAt, item.endsAt) + ' · 报名 ' + item.registrationCount + ' 人'
      }))
    },
    {
      key: 'registrations',
      title: '活动报名',
      rows: impact.registrations.map((item) => ({
        id: item.id,
        text: item.title,
        detail: timeRange(item.startsAt, item.endsAt)
      }))
    },
    {
      key: 'dissolvedTeams',
      title: '解散队伍',
      rows: impact.dissolvedTeams.map((item) => ({ id: item.id, text: item.name, detail: '' }))
    },
    {
      key: 'memberships',
      title: '队伍成员关系',
      rows: impact.memberships.map((item) => ({ id: item.id, text: item.teamName, detail: '' }))
    },
    {
      key: 'sessions',
      title: '队伍场次',
      rows: impact.sessions.map((item) => ({
        id: item.id,
        text: item.teamName,
        detail: timeRange(item.startsAt, item.endsAt)
      }))
    },
    {
      key: 'sessionMembers',
      title: '未来场次转待补位',
      rows: (impact.sessionMembers ?? []).map((item) => ({
        id: item.id,
        text: item.teamName,
        detail: timeRange(item.startsAt, item.endsAt)
      }))
    },
    {
      key: 'substitutes',
      title: '临时补位',
      rows: impact.substitutes.map((item) => ({
        id: item.id,
        text: item.teamName,
        detail: timeRange(item.startsAt, item.endsAt)
      }))
    },
    {
      key: 'applications',
      title: '待审入队申请',
      rows: impact.applications.map((item) => ({ id: item.id, text: item.teamName, detail: '' }))
    }
  ];
  return (
    <div className="account-lifecycle-impact">
      <dl className="account-lifecycle-counts">
        {groups.map((group) => (
          <div key={group.key}>
            <dt>{group.title}</dt>
            <dd>{group.rows.length}</dd>
          </div>
        ))}
        <div>
          <dt>失效登录会话</dt>
          <dd>{impact.sessionsRevoked}</dd>
        </div>
      </dl>
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section key={group.key} className="account-lifecycle-impact-group">
            <h3>
              {group.title}（{group.rows.length}）
            </h3>
            <ul>
              {group.rows.map((item) => (
                <li key={item.id}>
                  <span>{item.text}</span>
                  {item.detail ? <span className="management-meta">{item.detail}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function timeRange(startsAt: string, endsAt: string) {
  return beijingFull(startsAt) + ' — ' + beijingFull(endsAt);
}

function LifecycleAudits({ refresh, disabled }: { refresh: number; disabled: boolean }) {
  const [page, setPage] = useState(1),
    [retry, setRetry] = useState(0);
  const resource = useManagementResource<NumberedPageResult<LifecycleAudit>>(
    '/api/admin/account-lifecycle/audits?page=' +
      page +
      '&pageSize=10&refresh=' +
      refresh +
      '&retry=' +
      retry,
    { keepPrevious: true, revalidate: !disabled }
  );
  if (resource.blocked) return null;
  return (
    <section className="management-audits">
      <h2>操作记录</h2>
      <div className="management-error">
        <ErrorNotice message={resource.error} />
        {resource.error ? (
          <Button disabled={disabled} onClick={() => setRetry((value) => value + 1)}>
            重试读取记录
          </Button>
        ) : null}
      </div>
      <ManagementTable>
        <Table<LifecycleAudit>
          rowKey="id"
          loading={resource.loading}
          dataSource={resource.data?.items ?? []}
          pagination={false}
          scroll={{ x: 680 }}
          locale={{ emptyText: '暂无操作记录' }}
          expandable={{
            expandedRowRender: (row) => <LifecycleImpactList impact={row.impact} />,
            columnTitle: '影响',
            expandRowByClick: false
          }}
          columns={[
            {
              title: '时间 / 操作人',
              key: 'actor',
              render: (_, row) => (
                <span>
                  {beijingFull(row.createdAt)} · {row.actor.displayName || '超级管理员'}
                </span>
              )
            },
            { title: '目标账号', key: 'target', render: (_, row) => row.target.displayName || '成员' },
            {
              title: '变更',
              key: 'change',
              render: (_, row) =>
                (row.beforeActive ? '正常' : '已停用') + ' → ' + (row.afterActive ? '正常' : '已停用')
            },
            { title: '原因', dataIndex: 'reason' }
          ]}
        />
      </ManagementTable>
      {resource.data && resource.data.total > 0 ? (
        <ListPagination
          page={page}
          totalPages={Math.ceil(resource.data.total / 10)}
          loading={resource.loading || disabled}
          onPageChange={setPage}
          label="账号操作记录分页"
        />
      ) : null}
    </section>
  );
}
