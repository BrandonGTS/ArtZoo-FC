'use client';
import { AdminReturnLink } from '../admin-return-link';

import { useEffect, useState } from 'react';
import { Button, Input, Modal, Table } from 'antd';
import type { ManagementAccount, NumberedPageResult } from '@artzoo/domain';
import { ActivityPaper } from '../activities/activity-ui';
import { PageHeading } from '../page-heading';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { SuperAdminOnly, useSuperAdminScope } from './super-admin-scope';
import { useManagementCommand, useManagementResource } from './management-api';
import { ManagementAudits, ManagementTable, roleLabels } from './management-audits';
import { CollectionSearch, ListPagination } from '../collection-controls';
import './admin-management.css';
export default function RolesAdmin({
  embedded = false,
  onLocked
}: {
  embedded?: boolean;
  onLocked?(locked: boolean): void;
}) {
  return (
    <SuperAdminOnly>
      <OwnedRolesAdmin embedded={embedded} onLocked={onLocked} />
    </SuperAdminOnly>
  );
}
function OwnedRolesAdmin({ embedded, onLocked }: { embedded: boolean; onLocked?(locked: boolean): void }) {
  const { actorId } = useSuperAdminScope(),
    { notify, contextHolder } = useFeedbackMessage();
  const [draft, setDraft] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const [target, setTarget] = useState<ManagementAccount | null>(null),
    [reason, setReason] = useState(''),
    [conflicted, setConflicted] = useState(false),
    [replacing, setReplacing] = useState(false);
  const command = useManagementCommand<{ account: ManagementAccount; replayed: boolean }>({
    success(result, request) {
      if (
        !target ||
        result?.account?.id !== target.id ||
        typeof result.account.adminRoleRevision !== 'number'
      )
        throw new Error('Invalid response');
      notify(
        'success',
        result.replayed
          ? '操作结果已确认'
          : request.kind === 'json' && request.body.adminRole === 'ADMIN'
            ? '已授予管理员资格'
            : '已撤销管理员资格'
      );
      setTarget(null);
      setReason('');
      setConflicted(false);
      setReload((value) => value + 1);
    },
    failure(code) {
      if (code === 'CONFLICT') setConflicted(true);
    }
  });
  const list = useManagementResource<NumberedPageResult<ManagementAccount>>(
    query
      ? '/api/admin/management/accounts?query=' +
          encodeURIComponent(query) +
          '&page=' +
          page +
          '&pageSize=20&refresh=' +
          reload
      : null,
    { keepPrevious: true, revalidate: !command.locked }
  );
  if (!list.loading && list.data && page > Math.max(1, Math.ceil(list.data.total / 20)))
    setPage(Math.max(1, Math.ceil(list.data.total / 20)));
  const remote = target ? list.data?.items.find((item) => item.id === target.id) : null;
  const [knownRevision, setKnownRevision] = useState(0);
  if (target && remote && remote.adminRoleRevision > knownRevision)
    setKnownRevision(remote.adminRoleRevision);
  const stale = Boolean(target && (conflicted || knownRevision > target.adminRoleRevision));
  if (replacing && !list.loading) {
    setReplacing(false);
    if (!list.error) {
      if (remote) {
        setTarget(remote);
        setReason('');
        setConflicted(false);
        setKnownRevision(remote.adminRoleRevision);
      } else {
        setTarget(null);
        setReason('');
        setConflicted(false);
      }
    }
  }
  useEffect(() => {
    onLocked?.(command.locked || Boolean(target));
    return () => onLocked?.(false);
  }, [command.locked, target, onLocked]);
  useEffect(() => {
    if (command.error && !command.unknown) notify('error', command.error);
  }, [command.error, command.unknown, notify]);
  function open(account: ManagementAccount) {
    if (command.locked || account.adminRole === 'SUPER_ADMIN' || account.id === actorId) return;
    setTarget(account);
    setKnownRevision(account.adminRoleRevision);
    setReason('');
    setConflicted(false);
    command.setError(null);
  }
  function close() {
    if (command.locked) return;
    setTarget(null);
    setReason('');
    setConflicted(false);
    command.setError(null);
  }
  async function confirm() {
    if (
      !target ||
      command.locked ||
      stale ||
      replacing ||
      target.adminRole === 'SUPER_ADMIN' ||
      target.id === actorId
    )
      return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    await command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/admin/management/accounts/' + target.id + '/role',
      body: {
        adminRole: target.adminRole === 'ADMIN' ? 'NONE' : 'ADMIN',
        expectedRole: target.adminRole,
        expectedRevision: target.adminRoleRevision,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID()
      }
    });
  }
  const revoke = target?.adminRole === 'ADMIN',
    protectedTarget = target?.adminRole === 'SUPER_ADMIN' || target?.id === actorId;
  if (list.blocked) return null;
  const Container = embedded ? 'div' : 'main';
  return (
    <Container
      className={embedded ? 'management-embedded' : 'home-content management-content'}
      id={embedded ? undefined : 'main-content'}
    >
      {contextHolder}
      {embedded ? null : (
        <div className="management-heading">
          <PageHeading level={1} decoration="burger">
            管理员资格
          </PageHeading>
          <AdminReturnLink disabled={command.locked} />
        </div>
      )}
      <ActivityPaper className="management-panel management-paper-panel">
        <div className="management-search">
          <CollectionSearch
            id="management-account-query"
            searchLabel="搜索账号"
            placeholder="搜索成员或朋友"
            query={draft}
            disabled={command.locked || Boolean(target)}
            onQueryChange={setDraft}
            onSearch={(value) => {
              setQuery(value.trim());
              setPage(1);
              command.setError(null);
            }}
            onClear={() => {
              setDraft('');
              setQuery('');
              setPage(1);
              command.setError(null);
            }}
          />
        </div>
        <div className="management-error">
          <ErrorNotice message={list.error} />
          {list.error ? (
            <Button disabled={command.locked} onClick={() => setReload((value) => value + 1)}>
              重试读取
            </Button>
          ) : null}
        </div>
        <ManagementTable>
          <Table<ManagementAccount>
            rowKey="id"
            dataSource={list.data?.items ?? []}
            loading={list.loading}
            pagination={false}
            scroll={{ x: 680 }}
            locale={{ emptyText: query ? '没有找到账号' : '请输入搜索内容' }}
            columns={[
              {
                title: '成员',
                key: 'account',
                render: (_, account) => (
                  <div>
                    <span>{account.displayName || '成员'}</span>
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
                title: '操作',
                key: 'action',
                render: (_, account) => (
                  <Button
                    danger={account.adminRole === 'ADMIN'}
                    disabled={
                      command.locked ||
                      list.loading ||
                      Boolean(target) ||
                      account.adminRole === 'SUPER_ADMIN' ||
                      account.id === actorId
                    }
                    onClick={() => open(account)}
                  >
                    {account.adminRole === 'SUPER_ADMIN'
                      ? '超级管理员'
                      : account.adminRole === 'ADMIN'
                        ? '撤销管理员'
                        : '授予管理员'}
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
            loading={list.loading || command.locked || Boolean(target)}
            onPageChange={setPage}
            label="管理员账号分页"
          />
        ) : null}
        <ManagementAudits scope="roles" refresh={reload} disabled={command.locked} />
      </ActivityPaper>
      <Modal
        title={revoke ? '撤销管理员资格' : '授予管理员资格'}
        open={Boolean(target)}
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
              {stale ? (
                <Button
                  loading={replacing}
                  disabled={replacing}
                  onClick={() => {
                    setReplacing(true);
                    setReload((value) => value + 1);
                  }}
                >
                  重新读取账号
                </Button>
              ) : !protectedTarget ? (
                <Button
                  type="primary"
                  danger={revoke}
                  loading={command.busy}
                  disabled={command.locked || replacing}
                  onClick={() => void confirm()}
                >
                  {revoke ? '确认撤销' : '确认授予'}
                </Button>
              ) : null}
            </>
          )
        }
      >
        {target ? (
          <div className="management-role-confirm">
            <p className="management-role-target">
              {target.displayName || '成员'} · {target.phoneMasked}
            </p>
            <p>
              {protectedTarget
                ? '不能变更超级管理员资格。'
                : revoke
                  ? '将撤销普通管理员资格，停止其管理操作。成员或朋友身份保持不变。'
                  : '将授予普通管理员资格，可使用现有管理功能。成员或朋友身份保持不变。'}
            </p>
            <label className="management-role-form" htmlFor="management-role-reason">
              操作原因
              <Input.TextArea
                autoComplete="off"
                id="management-role-reason"
                rows={3}
                maxLength={500}
                value={reason}
                disabled={command.locked || stale || protectedTarget || replacing}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {stale ? <ErrorNotice message="账号资格已变化，重新读取将放弃未提交的原因。" /> : null}
            <ErrorNotice message={command.error} />
          </div>
        ) : null}
      </Modal>
    </Container>
  );
}
