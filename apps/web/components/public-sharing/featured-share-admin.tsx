'use client';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Button, Input } from 'antd';
import type { ActivityShareList, AdminActivityShare } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { PageHeading } from '../page-heading';
import { beijingFull } from '../activities/activity-ui';
import { useSharingCommand, useSharingResource } from './sharing-api';
import { ShareAudits } from './share-editor';
import { ListPagination } from '../collection-controls';
import '../albums/albums.css';
type Props = {
  query: string;
  notify(type: 'success' | 'error', text: string): void;
  onLock(value: boolean): void;
};
export default function FeaturedShareAdmin({ query, notify, onLock }: Props) {
  const [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [historyPage, setHistoryPage] = useState(1),
    [locked, setLocked] = useState(false);
  const list = useSharingResource<ActivityShareList<AdminActivityShare>>(
    '/api/activity-shares?manage=1&page=' +
      page +
      '&query=' +
      encodeURIComponent(query) +
      '&refresh=' +
      reload,
    'admin',
    false,
    !locked
  );
  if (!list.loading && list.data && page > Math.max(1, Math.ceil(list.data.total / 12))) {
    setPage(Math.max(1, Math.ceil(list.data.total / 12)));
    setSelected(null);
    setHistoryPage(1);
  }
  const id =
    selected && list.data?.items.some((item) => item.id === selected) ? selected : list.data?.items[0]?.id;
  const detail = useSharingResource<AdminActivityShare>(
    id ? '/api/activity-shares/' + id + '?manage=1&historyPage=' + historyPage + '&refresh=' + reload : null,
    'admin',
    true,
    !locked
  );
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [locked, onLock]);
  return (
    <>
      <ErrorNotice message={list.error} />
      <div className="album-featured-layout sharing-management-layout">
        <aside className="album-featured-sidebar">
          <PageHeading decoration="tomato">已精选活动分享</PageHeading>
          {list.loading ? <p role="status">正在读取活动分享…</p> : null}
          {list.data?.items.map((share) => (
            <Button
              type="text"
              block
              className="album-featured-item sharing-featured-item"
              key={share.id}
              aria-current={id === share.id}
              disabled={locked}
              onClick={() => {
                setSelected(share.id);
                setHistoryPage(1);
              }}
            >
              <span>{share.title}</span>
              <span className="album-card-meta">活动：{share.activity.title}</span>
              <span className="album-card-meta">
                作者：{share.creator.displayName ?? '管理员'} · {beijingFull(share.createdAt)}
              </span>
            </Button>
          ))}
          {list.data && !list.data.items.length ? <p>暂无已精选活动分享</p> : null}
          {list.data ? (
            <ListPagination
              page={list.data.page}
              totalPages={Math.ceil(list.data.total / 12)}
              loading={list.loading || locked}
              onPageChange={(value) => {
                setPage(value);
                setSelected(null);
                setHistoryPage(1);
              }}
              label="精选活动分享分页"
            />
          ) : null}
        </aside>
        <section className="album-featured-detail">
          <ErrorNotice message={detail.error} />
          {detail.data?.featuredAt ? (
            <ShareSelection
              key={detail.data.id + ':' + detail.data.revision}
              share={detail.data}
              historyPage={historyPage}
              historyLoading={detail.loading}
              onHistory={setHistoryPage}
              onLock={setLocked}
              notify={notify}
              removed={() => {
                setLocked(false);
                setSelected(null);
                setHistoryPage(1);
                setReload((value) => value + 1);
              }}
            />
          ) : detail.loading ? (
            <p role="status">正在读取活动分享…</p>
          ) : (
            <p>暂无已精选活动分享</p>
          )}
        </section>
      </div>
    </>
  );
}
function ShareSelection({
  share,
  historyPage,
  historyLoading,
  onHistory,
  onLock,
  notify,
  removed
}: {
  share: AdminActivityShare;
  historyPage: number;
  historyLoading: boolean;
  onHistory(value: number): void;
  onLock(value: boolean): void;
  notify(type: 'success' | 'error', text: string): void;
  removed(): void;
}) {
  const [reason, setReason] = useState('');
  const command = useSharingCommand<{ share: AdminActivityShare; replayed: boolean }>({
    notify,
    success(result) {
      if (result?.share?.id !== share.id || result.share.featuredAt) throw new Error('Invalid response');
      notify('success', '已取消精选');
      removed();
    }
  });
  useEffect(() => {
    onLock(command.locked);
    return () => onLock(false);
  }, [command.locked, onLock]);
  function remove() {
    if (command.locked) return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    void command.submit({
      kind: 'json',
      path: '/api/activity-shares/' + share.id,
      body: {
        action: 'UNFEATURE',
        expectedRevision: share.revision,
        idempotencyKey: crypto.randomUUID(),
        reason: reason.trim()
      }
    });
  }
  return (
    <>
      <div className="sharing-detail-heading">
        <h3>{share.title}</h3>
        <span className="sharing-meta">活动分享 · 已精选</span>
      </div>
      <div className="album-featured-photo">
        {share.media[0] ? (
          <Image unoptimized src={share.media[0].previewUrl} width={380} height={190} alt={share.title} />
        ) : null}
        <div>
          <p>关联活动 {share.activity.title}</p>
          <p>作者 {share.creator.displayName ?? '管理员'}</p>
          <p>创建时间 {beijingFull(share.createdAt)}</p>
          <p>公开精选 已选入</p>
        </div>
      </div>
      <p className="sharing-body">{share.body}</p>
      <div className="sharing-unfeature">
        <h3>取消精选</h3>
        <label htmlFor="share-unfeature-reason">
          操作原因
          <Input.TextArea
            autoComplete="off"
            id="share-unfeature-reason"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={command.locked}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
      <ErrorNotice
        message={
          command.unknown
            ? '操作可能已成功，当前结果尚未确认。请使用“重试确认操作”沿用原请求确认结果。'
            : null
        }
      />
      <div className="sharing-actions">
        {command.unknown ? (
          <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
            重试确认操作
          </Button>
        ) : (
          <>
            <Button disabled={command.locked} href={'/admin/activity-shares/' + share.id}>
              查看详情
            </Button>
            <Button danger disabled={command.locked} loading={command.busy} onClick={remove}>
              取消精选
            </Button>
          </>
        )}
      </div>
      <ShareAudits
        share={share}
        page={historyPage}
        loading={historyLoading}
        disabled={command.locked}
        onChange={onHistory}
      />
    </>
  );
}
