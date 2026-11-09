'use client';
import { AdminReturnLink } from '../admin-return-link';
import { useState } from 'react';
import { Button } from 'antd';
import type { ContactList, ContactMessage, ContactStatus } from '../../server/guest-contact/contract';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../page-heading';
import { ActivityPaper, beijingFull } from '../activities/activity-ui';
import { CollectionFilters, ListPagination } from '../collection-controls';
import { ErrorNotice } from '../account/account-ui';
import { useSharingCommand, useSharingResource } from '../public-sharing/sharing-api';
import { useFeedbackMessage } from '../use-feedback-message';
import StickerText from '../stickers/sticker-text';
import './guest-contact.css';

export default function ContactAdmin() {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  if (loading || !actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.adminRole)) return null;
  const owner = [actor.id, actor.membership, actor.adminRole].join(':');
  return <OwnedContactAdmin key={owner} owner={owner} />;
}
function OwnedContactAdmin({ owner }: { owner: string }) {
  const [status, setStatus] = useState<ContactStatus>('PENDING'),
    [page, setPage] = useState(1);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [reload, setReload] = useState(0);
  const [lockedId, setLockedId] = useState<string | null>(null),
    [denied, setDenied] = useState(false);
  const { notify, contextHolder } = useFeedbackMessage();
  const resource = useSharingResource<ContactList>(
    denied
      ? null
      : '/api/admin/contact-requests?' +
          new URLSearchParams({
            status,
            page: String(page),
            pageSize: '12',
            query: search,
            refresh: String(reload)
          }),
    owner,
    false,
    !lockedId
  );
  const blocked = denied || ['FORBIDDEN', 'UNAUTHENTICATED'].includes(resource.errorCode ?? '');
  function updateSearch(value: string) {
    setSearch(value.trim());
    setPage(1);
  }
  return (
    <main className="home-content" id="main-content">
      {contextHolder}
      <div className="guest-contact-admin-heading">
        <PageHeading level={1} decoration="burger">
          游客联系留言
        </PageHeading>
        <AdminReturnLink disabled={Boolean(lockedId)} />
      </div>
      {blocked ? (
        <ErrorNotice message="管理权限已变化，请重新确认登录状态。" />
      ) : (
        <>
          <CollectionFilters
            tabs={[
              { key: 'PENDING', label: '待处理' },
              { key: 'PROCESSED', label: '已处理' }
            ]}
            activeKey={status}
            onTabChange={(key) => {
              setStatus(key as ContactStatus);
              setPage(1);
            }}
            disabled={Boolean(lockedId)}
            query={query}
            onQueryChange={setQuery}
            onSearch={updateSearch}
            onClear={() => {
              setQuery('');
              updateSearch('');
            }}
            searchLabel="搜索QQ或留言"
            placeholder="搜索QQ或留言"
          />
          {resource.loading ? <p role="status">正在读取留言…</p> : null}
          <ErrorNotice message={resource.error} />
          {resource.error ? (
            <Button disabled={Boolean(lockedId)} onClick={() => setReload((value) => value + 1)}>
              重试读取
            </Button>
          ) : null}
          {resource.data ? (
            <>
              <div className="guest-contact-admin-list">
                {resource.data.items.map((item) => (
                  <ContactItem
                    key={item.id + ':' + item.revision}
                    item={item}
                    disabled={Boolean(lockedId) && lockedId !== item.id}
                    onLock={(locked) => setLockedId(locked ? item.id : null)}
                    onDone={(replayed) => {
                      notify('success', replayed ? '此留言已处理' : '已标记为已处理');
                      setLockedId(null);
                      setReload((value) => value + 1);
                    }}
                    onDenied={() => setDenied(true)}
                    notify={notify}
                  />
                ))}
                {!resource.data.items.length ? (
                  <p>
                    {search
                      ? '没有符合搜索条件的留言。'
                      : status === 'PENDING'
                        ? '暂无待处理留言。'
                        : '暂无已处理留言。'}
                  </p>
                ) : null}
              </div>
              <ListPagination
                page={page}
                totalPages={Math.ceil(resource.data.total / resource.data.pageSize)}
                loading={Boolean(lockedId) || resource.loading}
                onPageChange={setPage}
                label="游客留言分页"
              />
            </>
          ) : null}
        </>
      )}
    </main>
  );
}
function ContactItem({
  item,
  disabled,
  onLock,
  onDone,
  onDenied,
  notify
}: {
  item: ContactMessage;
  disabled: boolean;
  onLock(locked: boolean): void;
  onDone(replayed: boolean): void;
  onDenied(): void;
  notify(type: 'success' | 'error', text: string): void;
}) {
  const command = useSharingCommand<{ item: ContactMessage; replayed: boolean }>({
    notify,
    success(result) {
      if (
        result?.item?.id !== item.id ||
        result.item.status !== 'PROCESSED' ||
        typeof result.replayed !== 'boolean'
      )
        throw new Error('Invalid response');
      onDone(result.replayed);
    },
    failure(code) {
      onLock(false);
      if (['FORBIDDEN', 'UNAUTHENTICATED'].includes(code)) onDenied();
    }
  });
  async function process() {
    if (command.locked || disabled) return;
    onLock(true);
    await command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/admin/contact-requests/' + item.id,
      body: { expectedRevision: item.revision }
    });
  }
  return (
    <ActivityPaper className="guest-contact-admin-item">
      <h2>QQ：{item.qq}</h2>
      <p>
        <StickerText text={item.message} />
      </p>
      <div className="guest-contact-admin-meta">
        <p>提交于 {beijingFull(item.createdAt)}</p>
        {item.status === 'PROCESSED' ? (
          <p>
            处理人：{item.processedBy?.displayName || '管理员'}
            {item.processedAt ? ' · ' + beijingFull(item.processedAt) : ''}
          </p>
        ) : null}
      </div>
      {item.status === 'PENDING' ? (
        <div className="guest-contact-admin-actions">
          {command.unknown ? (
            <>
              <span role="status">暂时无法确认结果，请重试确认。</span>
              <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
                重试确认处理
              </Button>
            </>
          ) : (
            <Button
              type="primary"
              disabled={disabled || command.locked}
              loading={command.busy}
              onClick={() => void process()}
            >
              标记为已处理
            </Button>
          )}
        </div>
      ) : null}
    </ActivityPaper>
  );
}
