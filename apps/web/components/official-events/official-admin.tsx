'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AdminReturnLink } from '../admin-return-link';
import { toBeijingPicker } from '@artzoo/domain';
import { beijingPickerTimestamp } from '../beijing-picker';
import dayjs from 'dayjs';
import { Button, ConfigProvider, DatePicker, Image, Input, Modal, Table } from 'antd';
import type {
  OfficialEventAction,
  OfficialEventDetail,
  OfficialEventList,
  OfficialEventStatus,
  OfficialEventWrite,
  OfficialSyncRunView
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { useApiResource } from '../shared/use-api-resource';
import { ErrorNotice } from '../account/account-ui';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import { useFeedbackMessage } from '../use-feedback-message';
import { ActivityPaper, beijingFull } from '../activities/activity-ui';
import { CollectionTabs, ListPagination } from '../collection-controls';
import './official-events.css';

const statuses: Record<OfficialEventStatus, string> = {
  PENDING: '待处理',
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  WITHDRAWN: '已下架'
};
const actions: Record<string, string> = {
  SAVE: '保存修改',
  APPROVE: '审核发布',
  REJECT: '驳回',
  WITHDRAW: '下架',
  COLLECTED: '采集入库',
  SYNCED: '自动同步'
};
const runStatuses: Record<string, string> = {
  RUNNING: '采集中',
  COMPLETED: '采集完成',
  PARTIAL: '部分完成',
  FAILED: '采集失败',
  SKIPPED: '本次跳过'
};
const uncertainCodes = new Set(['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR']);
function useOfficialRead<T>(path: string | null, keepPrevious = false) {
  return useApiResource<T>(path, { adapter: 'official', keepPreviousData: keepPrevious });
}

function dateValue(value: string | null) {
  return value ? dayjs(toBeijingPicker(new Date(value), 'second')) : null;
}
function completeTime(value: dayjs.Dayjs | null) {
  return value ? new Date(beijingPickerTimestamp(value.format('YYYY-MM-DDTHH:mm:ss'))).toISOString() : null;
}
export default function OfficialAdmin() {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  return !loading && actor && (actor.adminRole === 'ADMIN' || actor.adminRole === 'SUPER_ADMIN') ? (
    <OwnedOfficialAdmin key={[actor.id, actor.membership, actor.adminRole].join(':')} />
  ) : null;
}
function OwnedOfficialAdmin() {
  const [status, setStatus] = useState<OfficialEventStatus | 'ALL'>('ALL'),
    [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null),
    [historyPage, setHistoryPage] = useState(1),
    [reload, setReload] = useState(0);
  const [locked, setLocked] = useState(false),
    [syncBusy, setSyncBusy] = useState(false);
  const [syncUnknown, setSyncUnknown] = useState(false);
  const detailBody = useRef<HTMLDivElement>(null),
    sidebar = useRef<HTMLElement>(null);
  const selectionViewport = useRef<{ x: number; y: number; sidebarTop: number } | null>(null);
  const [detailHeight, setDetailHeight] = useState(0);
  const syncCommand = useRef<{ idempotencyKey: string } | null>(null),
    syncPending = useRef(false),
    syncAbort = useRef<AbortController | null>(null);
  const { notify, contextHolder } = useFeedbackMessage();
  const list = useOfficialRead<OfficialEventList>(
    '/api/admin/official-events?status=' + status + '&page=' + page + '&refresh=' + reload
  );
  if (!list.loading && list.data && page > Math.max(1, Math.ceil(list.data.total / 12)))
    setPage(Math.max(1, Math.ceil(list.data.total / 12)));
  const eventId = selected ?? list.data?.items[0]?.id ?? null;
  const detail = useOfficialRead<OfficialEventDetail>(
    eventId
      ? '/api/admin/official-events/' + eventId + '?historyPage=' + historyPage + '&refresh=' + reload
      : null,
    true
  );
  useEffect(() => () => syncAbort.current?.abort(), []);
  useEffect(() => {
    const cancel = () => {
      selectionViewport.current = null;
    };
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchstart', cancel, { passive: true });
    window.addEventListener('pointerdown', cancel, { passive: true });
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, []);
  useLayoutEffect(() => {
    if (detail.loading || !selectionViewport.current) return;
    const position = selectionViewport.current;
    selectionViewport.current = null;
    if (sidebar.current) sidebar.current.scrollTop = position.sidebarTop;
    window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
  }, [detail.loading, detail.data, detail.error]);
  async function sync() {
    if (syncPending.current || (locked && !syncCommand.current)) return;
    syncPending.current = true;
    setSyncBusy(true);
    setLocked(true);
    const body = syncCommand.current ?? { idempotencyKey: crypto.randomUUID() };
    syncCommand.current = body;
    const controller = new AbortController();
    syncAbort.current = controller;
    let unresolved = false;
    try {
      const result = await accountRequest<{ run: OfficialSyncRunView; replayed: boolean }>(
        '/api/admin/official-events/sync',
        { method: 'POST', body, signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      if (
        !result?.run?.id ||
        !Object.hasOwn(runStatuses, result.run.status) ||
        !Number.isFinite(result.run.imported) ||
        !Number.isFinite(result.run.unchanged) ||
        !Array.isArray(result.run.errors) ||
        result.run.errors.some((error) => typeof error !== 'string')
      )
        throw new Error('Invalid response');
      unresolved = result.run.status === 'RUNNING';
      setReload((value) => value + 1);
      setSyncUnknown(unresolved);
      if (!unresolved) syncCommand.current = null;
      const outcome =
        result.run.status === 'COMPLETED' ? 'success' : result.run.status === 'FAILED' ? 'error' : 'warning';
      notify(
        outcome,
        [
          runStatuses[result.run.status] ?? '采集状态未知',
          `同步 ${result.run.imported} · 未变化 ${result.run.unchanged}`,
          ...result.run.errors
        ].join('；')
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      const detail = errorDetail(failure);
      unresolved = uncertainCodes.has(detail.code);
      setSyncUnknown(unresolved);
      notify(
        unresolved ? 'warning' : 'error',
        unresolved ? '暂时无法确认采集结果，请重试确认。' : detail.message
      );
      if (!unresolved) syncCommand.current = null;
    } finally {
      syncPending.current = false;
      if (!controller.signal.aborted) {
        setSyncBusy(false);
        setLocked(unresolved);
      }
    }
  }
  function choose(id: string) {
    if (locked || id === eventId) return;
    // Keep the document from shrinking under a scrolled sidebar while only the right panel changes.
    selectionViewport.current = {
      x: window.scrollX,
      y: window.scrollY,
      sidebarTop: sidebar.current?.scrollTop ?? 0
    };
    setDetailHeight((height) => Math.max(height, detailBody.current?.getBoundingClientRect().height ?? 0));
    setSelected(id);
    setHistoryPage(1);
  }
  return (
    <main className="home-content official-admin-content" id="main-content">
      {contextHolder}
      <div className="official-admin-heading">
        <PageHeading level={1} decoration="burger">
          官方活动管理
        </PageHeading>
        <AdminReturnLink disabled={locked} />
      </div>
      <div className="official-admin-filterbar">
        <CollectionTabs
          activeKey={status}
          disabled={locked}
          tabs={[
            { key: 'ALL', label: '全部状态' },
            ...Object.entries(statuses).map(([key, label]) => ({ key, label }))
          ]}
          onTabChange={(value) => {
            selectionViewport.current = null;
            setDetailHeight(0);
            setStatus(value as OfficialEventStatus | 'ALL');
            setPage(1);
            setSelected(null);
            setHistoryPage(1);
          }}
        />
        <Button
          type="primary"
          loading={syncBusy}
          disabled={locked && !syncUnknown}
          onClick={() => void sync()}
        >
          {syncUnknown ? '重试确认采集' : '立即同步'}
        </Button>
      </div>
      <ErrorNotice message={list.error} />
      {list.error ? (
        <Button disabled={locked} onClick={() => setReload((value) => value + 1)}>
          重新读取
        </Button>
      ) : null}
      <div className="official-admin-layout">
        <ActivityPaper className="official-admin-sidebar">
          <section ref={sidebar}>
            <PageHeading decoration="tomato">{status === 'ALL' ? '官方活动' : statuses[status]}</PageHeading>
            {list.loading ? <p role="status">正在读取活动…</p> : null}
            {list.data?.items.map((item) => (
              <Button
                type="text"
                block
                key={item.id}
                className="official-admin-item"
                aria-current={eventId === item.id}
                disabled={locked}
                onClick={() => choose(item.id)}
              >
                <span className="official-admin-item-title">{item.title}</span>
                <span className="activity-note">
                  {statuses[item.status]} · {beijingFull(item.createdAt)}
                </span>
              </Button>
            ))}
            {list.data && !list.data.items.length ? <p className="activity-note">暂无活动</p> : null}
            {list.data && list.data.total > 0 ? (
              <ListPagination
                page={page}
                totalPages={Math.ceil(list.data.total / 12)}
                loading={list.loading || locked}
                onPageChange={(value) => {
                  selectionViewport.current = null;
                  setDetailHeight(0);
                  setPage(value);
                  setSelected(null);
                  setHistoryPage(1);
                }}
                label="官方活动分页"
              />
            ) : null}
          </section>
        </ActivityPaper>
        <ActivityPaper className="official-admin-detail">
          <div
            ref={detailBody}
            className="official-admin-detail-body"
            aria-busy={detail.loading}
            style={{ minHeight: detailHeight || undefined }}
          >
            {detail.error ? (
              <>
                <ErrorNotice message={detail.error} />
                <Button disabled={locked} onClick={() => setReload((value) => value + 1)}>
                  重新读取
                </Button>
              </>
            ) : detail.data ? (
              <OfficialEditor
                key={detail.data.id + ':' + detail.data.revision}
                event={detail.data}
                locked={locked || detail.loading}
                onLock={setLocked}
                historyPage={historyPage}
                historyLoading={detail.loading}
                notify={notify}
                onHistoryPage={setHistoryPage}
                onSaved={() => {
                  setHistoryPage(1);
                  setReload((value) => value + 1);
                }}
              />
            ) : detail.loading ? (
              <p role="status">正在读取活动…</p>
            ) : (
              <p className="activity-note">请选择活动</p>
            )}
          </div>
        </ActivityPaper>
      </div>
    </main>
  );
}
type WriteCommand = {
  action: OfficialEventAction;
  expectedRevision: number;
  idempotencyKey: string;
  startsAt?: string | null;
  endsAt?: string | null;
  reason?: string;
};
function OfficialEditor({
  event,
  locked,
  onLock,
  historyPage,
  historyLoading,
  notify,
  onHistoryPage,
  onSaved
}: {
  event: OfficialEventDetail;
  locked: boolean;
  onLock(value: boolean): void;
  historyPage: number;
  historyLoading: boolean;
  notify(type: 'success' | 'error', content: string): void;
  onHistoryPage(value: number): void;
  onSaved(): void;
}) {
  const editable = event.status === 'PENDING' || event.status === 'PUBLISHED';
  const [startsAt, setStartsAt] = useState(event.startsAt),
    [endsAt, setEndsAt] = useState(event.endsAt);
  const [reason, setReason] = useState(''),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<OfficialEventAction | null>(null),
    [unknown, setUnknown] = useState(false);
  const [stale, setStale] = useState(false),
    [withdrawConfirm, setWithdrawConfirm] = useState(false);
  const pending = useRef(false),
    command = useRef<WriteCommand | null>(null),
    abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function write(action: OfficialEventAction) {
    if (pending.current || (locked && !command.current) || stale) return;
    if (!command.current) {
      const editing = action === 'SAVE' || action === 'APPROVE';
      if (action === 'APPROVE' && (!startsAt || !endsAt)) {
        setError('请填写开始时间和结束时间。');
        return;
      }
      if (
        (action === 'SAVE' || action === 'APPROVE') &&
        startsAt &&
        endsAt &&
        Date.parse(endsAt) <= Date.parse(startsAt)
      ) {
        setError('结束时间须晚于开始时间。');
        return;
      }
      if (action === 'REJECT' && !reason.trim()) {
        setError('请填写操作原因。');
        return;
      }
      command.current = {
        action,
        expectedRevision: event.revision,
        idempotencyKey: crypto.randomUUID(),
        ...(editing ? { startsAt, endsAt } : action === 'REJECT' ? { reason: reason.trim() } : {})
      };
    }
    const body = command.current;
    pending.current = true;
    setBusy(body.action);
    onLock(true);
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    let unresolved = false;
    try {
      const result = await accountRequest<OfficialEventWrite>('/api/admin/official-events/' + event.id, {
        method: 'POST',
        body,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      if (
        result?.event?.id !== event.id ||
        typeof result.event.revision !== 'number' ||
        !Array.isArray(result.event.audits)
      )
        throw new Error('Invalid response');
      command.current = null;
      setUnknown(false);
      setStale(true);
      notify('success', actions[body.action] + '成功');
      onSaved();
    } catch (failure) {
      if (controller.signal.aborted) return;
      const detail = errorDetail(failure);
      unresolved = uncertainCodes.has(detail.code);
      setUnknown(unresolved);
      setError(unresolved ? '暂时无法确认操作结果，请重试确认。' : detail.message);
      if (!unresolved) {
        command.current = null;
        setStale(detail.code.includes('CONFLICT') || detail.code.includes('REVISION'));
        notify('error', detail.message);
      }
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) {
        setBusy(null);
        onLock(unresolved);
      }
    }
  }
  return (
    <>
      <div className="official-detail-heading">
        <h3>{event.title}</h3>
        <span className="activity-note">{statuses[event.status]}</span>
      </div>
      <div className="official-source">
        <Button type="link" href={event.sourceUrl} target="_blank" rel="noopener noreferrer">
          查看原文
        </Button>
        <p className="official-source-url">{event.sourceUrl}</p>
        <div className="official-source-text">{event.sourceText || '暂无原文内容'}</div>
      </div>
      <div className="official-editor-fields">
        {event.image ? (
          <div className="official-current-image">
            <span className="activity-note">已采集配图</span>
            <Image
              src={event.image.thumbnailUrl}
              preview={{ src: event.image.previewUrl }}
              alt={event.title + '的官方活动配图'}
              classNames={{ root: 'official-admin-image', image: 'official-image-content' }}
              styles={{ image: { objectFit: 'contain' } }}
            />
          </div>
        ) : null}
        <div className="official-time-fields">
          <label htmlFor="official-starts">
            开始时间（北京时间）
            <DatePicker
              id="official-starts"
              value={dateValue(startsAt)}
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              showNow={false}
              disabled={!editable || locked || stale}
              onChange={(value) => setStartsAt(completeTime(value))}
            />
          </label>
          <label htmlFor="official-ends">
            结束时间（北京时间）
            <DatePicker
              id="official-ends"
              value={dateValue(endsAt)}
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              showNow={false}
              disabled={!editable || locked || stale}
              onChange={(value) => setEndsAt(completeTime(value))}
            />
          </label>
        </div>
        {event.status === 'PENDING' ? (
          <label htmlFor="official-reason">
            驳回原因
            <Input.TextArea
              autoComplete="off"
              id="official-reason"
              value={reason}
              onChange={(value) => setReason(value.target.value)}
              rows={3}
              maxLength={500}
              disabled={locked || stale}
            />
          </label>
        ) : null}
      </div>
      <ErrorNotice message={error} />
      <div className="official-admin-actions">
        {unknown ? (
          <Button type="primary" loading={busy !== null} onClick={() => void write(command.current!.action)}>
            重试确认操作
          </Button>
        ) : stale ? (
          <Button onClick={onSaved}>重新读取活动</Button>
        ) : (
          <>
            {event.status === 'PENDING' ? (
              <>
                <Button
                  danger
                  disabled={locked}
                  loading={busy === 'REJECT'}
                  onClick={() => void write('REJECT')}
                >
                  驳回
                </Button>
                <Button disabled={locked} loading={busy === 'SAVE'} onClick={() => void write('SAVE')}>
                  保存修改
                </Button>
                <Button
                  type="primary"
                  disabled={locked}
                  loading={busy === 'APPROVE'}
                  onClick={() => void write('APPROVE')}
                >
                  审核发布
                </Button>
              </>
            ) : null}
            {event.status === 'PUBLISHED' ? (
              <>
                <Button disabled={locked} loading={busy === 'SAVE'} onClick={() => void write('SAVE')}>
                  保存修改
                </Button>
                <Button
                  danger
                  disabled={locked}
                  loading={busy === 'WITHDRAW'}
                  onClick={() => setWithdrawConfirm(true)}
                >
                  下架活动
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
      <Modal
        className="official-withdraw-modal"
        title="下架官方活动"
        open={withdrawConfirm}
        onCancel={() => setWithdrawConfirm(false)}
        footer={
          <>
            <Button onClick={() => setWithdrawConfirm(false)}>取消</Button>
            <Button
              danger
              type="primary"
              onClick={() => {
                setWithdrawConfirm(false);
                void write('WITHDRAW');
              }}
            >
              确认下架
            </Button>
          </>
        }
      >
        <p>活动将从月历撤下，原文和操作记录保留。</p>
      </Modal>
      <div className="official-audit">
        <h3>操作记录</h3>
        <ConfigProvider
          theme={{
            components: {
              Table: {
                headerBg: 'var(--artzoo-fill)',
                rowHoverBg: 'var(--artzoo-fill)',
                colorBgContainer: 'transparent',
                headerSplitColor: 'transparent'
              }
            }
          }}
        >
          <Table
            rowKey="id"
            loading={historyLoading}
            dataSource={event.audits}
            pagination={false}
            scroll={{ x: 500 }}
            locale={{ emptyText: '暂无操作记录' }}
            columns={[
              {
                title: '时间 / 操作人',
                key: 'actor',
                render: (_, item) => (
                  <span>
                    {beijingFull(item.createdAt)} · {item.actor ? item.actor.displayName || '管理员' : '系统'}
                  </span>
                )
              },
              { title: '操作', key: 'action', render: (_, item) => actions[item.action] ?? item.action },
              { title: '原因', dataIndex: 'reason', render: (value: string) => value || '—' }
            ]}
          />
        </ConfigProvider>
        <ListPagination
          page={historyPage}
          totalPages={Math.ceil(event.historyTotal / 20)}
          loading={historyLoading || locked}
          onPageChange={onHistoryPage}
          label="官方活动操作记录分页"
        />
      </div>
    </>
  );
}
