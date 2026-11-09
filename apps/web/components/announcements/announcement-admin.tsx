'use client';
import { useState } from 'react';
import { Button, Checkbox, Input, Modal } from 'antd';
import {
  ANNOUNCEMENT_MAX_LENGTH,
  type AnnouncementList,
  type AnnouncementCommandResult
} from '../../server/announcements/contract';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../page-heading';
import { AdminReturnLink } from '../admin-return-link';
import DailyDeleteMenu from '../daily/daily-delete-menu';
import { ActivityPaper, beijingFull } from '../activities/activity-ui';
import { ListPagination } from '../collection-controls';
import { ErrorNotice } from '../account/account-ui';
import { useSharingCommand, useSharingResource } from '../public-sharing/sharing-api';
import { useFeedbackMessage } from '../use-feedback-message';
import './announcements.css';
export default function AnnouncementAdmin() {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  if (loading || !actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.adminRole)) return null;
  const owner = [actor.id, actor.membership, actor.adminRole].join(':');
  return <OwnedAnnouncementAdmin key={owner} owner={owner} />;
}
function OwnedAnnouncementAdmin({ owner }: { owner: string }) {
  const [text, setText] = useState(''),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<{ ids: string[]; revision: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    (AnnouncementList['items'][number] & { revision: number }) | null
  >(null);
  const [denied, setDenied] = useState(false),
    [stale, setStale] = useState(false);
  const { notify, contextHolder } = useFeedbackMessage();
  const command = useSharingCommand<AnnouncementCommandResult>({
    notify,
    success(result, request) {
      if (!Number.isSafeInteger(result.revision) || typeof result.replayed !== 'boolean')
        throw new Error('Invalid response');
      const publishing =
        request.kind === 'json' && request.path === '/api/admin/announcements' && request.method === 'POST';
      const deleting = request.kind === 'json' && request.path.endsWith('/remove');
      if (deleting && result.deleted !== true) throw new Error('Invalid response');
      if (publishing) {
        setText('');
        setPage(1);
      }
      const removedId = request.kind === 'json' ? request.path.split('/').at(-2) : null;
      setSelection((previous) =>
        deleting && previous
          ? { ids: previous.ids.filter((id) => id !== removedId), revision: result.revision }
          : null
      );
      setDeleteTarget(null);
      setStale(false);
      setReload((value) => value + 1);
      window.dispatchEvent(new Event('artzoo:announcements-updated'));
      notify(
        'success',
        result.replayed
          ? '已确认公告操作结果'
          : publishing
            ? '已发布，当前仅展示这条新公告'
            : deleting
              ? '已删除公告'
              : '已更新展示公告'
      );
    },
    failure(code) {
      setDeleteTarget(null);
      if (['FORBIDDEN', 'UNAUTHENTICATED'].includes(code)) setDenied(true);
      if (['CONFLICT', 'ANNOUNCEMENT_DELETED', 'NOT_FOUND'].includes(code)) setStale(true);
    }
  });
  const resource = useSharingResource<AnnouncementList>(
    denied
      ? null
      : '/api/admin/announcements?' +
          new URLSearchParams({ page: String(page), pageSize: '12', refresh: String(reload) }),
    owner,
    true,
    !command.locked && !deleteTarget
  );
  const data = resource.data,
    blocked = denied || ['FORBIDDEN', 'UNAUTHENTICATED'].includes(resource.errorCode ?? '');
  const selectedIds = selection?.ids ?? data?.selectedIds ?? [];
  const selectionStale = stale || Boolean(selection && data && selection.revision !== data.revision);
  function toggle(id: string, checked: boolean) {
    if (!data || command.locked) return;
    setSelection({
      revision: selection?.revision ?? data.revision,
      ids: checked ? [...selectedIds, id] : selectedIds.filter((value) => value !== id)
    });
  }
  function reread() {
    setSelection(null);
    setStale(false);
    command.setError(null);
    setReload((value) => value + 1);
  }
  return (
    <main className="home-content announcement-admin" id="main-content">
      {contextHolder}
      <div className="announcement-admin-heading">
        <PageHeading level={1} decoration="burger">
          公告管理
        </PageHeading>
        <AdminReturnLink disabled={command.locked} />
      </div>
      {blocked ? (
        <ErrorNotice message="管理权限已变化，请重新确认登录状态。" />
      ) : (
        <>
          <ActivityPaper className="announcement-publish">
            <h2>发布公告</h2>
            <p>发布后仅展示这条新公告，旧公告会保留在历史列表。</p>
            <label htmlFor="announcement-text">公告内容</label>
            <Input.TextArea
              id="announcement-text"
              value={text}
              disabled={command.locked}
              rows={4}
              maxLength={ANNOUNCEMENT_MAX_LENGTH * 2}
              onChange={(event) => setText(event.target.value)}
              placeholder="写下想告诉大家的事…"
              aria-describedby="announcement-count"
            />
            <div className="announcement-publish-actions">
              <span id="announcement-count">
                {[...text].length} / {ANNOUNCEMENT_MAX_LENGTH} 字
              </span>
              <Button
                type="primary"
                disabled={command.locked || !text.trim() || [...text.trim()].length > ANNOUNCEMENT_MAX_LENGTH}
                loading={command.busy}
                onClick={() =>
                  void command.submit({
                    kind: 'json',
                    method: 'POST',
                    path: '/api/admin/announcements',
                    body: { text, idempotencyKey: crypto.randomUUID() }
                  })
                }
              >
                发布公告
              </Button>
            </div>
          </ActivityPaper>
          <ActivityPaper className="announcement-history">
            <div className="announcement-history-heading">
              <h2>发布历史</h2>
              <span>{data ? `共 ${data.total} 条` : ''}</span>
            </div>
            <p>
              选中一条或多条展示，按发布时间从早到晚依次滚动；同一时间按固定顺序排列。至少选择一条后保存；删除展示中的公告不会自动恢复旧公告。
            </p>
            {resource.loading ? <p role="status">正在读取公告…</p> : null}
            <ErrorNotice message={resource.error} />
            {resource.error ? (
              <Button disabled={command.locked} onClick={() => setReload((value) => value + 1)}>
                重试读取
              </Button>
            ) : null}
            {data ? (
              <>
                <div className="announcement-history-list">
                  {data.items.map((item) => (
                    <div className="announcement-history-item" key={item.id}>
                      <div className="announcement-history-item-main">
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          disabled={command.locked || selectionStale}
                          onChange={(event) => toggle(item.id, event.target.checked)}
                        >
                          <span className="announcement-history-text">{item.text}</span>
                        </Checkbox>
                        <DailyDeleteMenu
                          label={'公告管理操作：' + [...item.text].slice(0, 20).join('')}
                          disabled={command.locked || resource.loading || selectionStale}
                          onDelete={() => {
                            command.setError(null);
                            setDeleteTarget({ ...item, revision: data.revision });
                          }}
                        />
                      </div>
                      <div className="announcement-history-meta">
                        <time dateTime={item.createdAt}>{beijingFull(item.createdAt)}</time>
                        {item.active ? <span>正在展示</span> : null}
                      </div>
                    </div>
                  ))}
                  {!data.total ? <p>暂无可管理的公告。</p> : null}
                </div>
                <ListPagination
                  page={data.page}
                  totalPages={Math.ceil(data.total / data.pageSize)}
                  loading={command.locked || resource.loading}
                  onPageChange={setPage}
                  label="公告历史分页"
                />
                {data.total ? (
                  <div className="announcement-selection-actions">
                    <span>已选择 {selectedIds.length} 条</span>
                    <Button
                      type="primary"
                      loading={command.busy}
                      disabled={
                        command.locked ||
                        resource.loading ||
                        !selection ||
                        !selectedIds.length ||
                        selectionStale
                      }
                      onClick={() =>
                        void command.submit({
                          kind: 'json',
                          method: 'PATCH',
                          path: '/api/admin/announcements/selection',
                          body: {
                            selectedIds,
                            expectedRevision: selection?.revision ?? data.revision,
                            idempotencyKey: crypto.randomUUID()
                          }
                        })
                      }
                    >
                      保存展示选择
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            {selectionStale ? (
              <p role="status">公告展示已更新。重新读取会清除未保存的展示选择，公告内容草稿会保留。</p>
            ) : null}
            {selectionStale ? (
              <Button disabled={command.locked} onClick={reread}>
                重新读取展示选择
              </Button>
            ) : null}
          </ActivityPaper>
          <ErrorNotice message={command.error} />
          {command.unknown && !deleteTarget ? (
            <div className="announcement-retry">
              <p role="status">暂时无法确认结果，请重试确认同次操作。</p>
              <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
                重试确认
              </Button>
            </div>
          ) : null}
          <Modal
            title="删除公告"
            open={Boolean(deleteTarget)}
            closable={!command.locked}
            keyboard={!command.locked}
            mask={{ closable: !command.locked }}
            onCancel={() => {
              if (!command.locked) setDeleteTarget(null);
            }}
            footer={
              <div className="announcement-delete-actions">
                <Button disabled={command.locked} onClick={() => setDeleteTarget(null)}>
                  取消
                </Button>
                <Button
                  danger
                  type="primary"
                  loading={command.busy}
                  onClick={() => {
                    if (command.unknown) void command.retry();
                    else if (deleteTarget)
                      void command.submit({
                        kind: 'json',
                        method: 'POST',
                        path: '/api/admin/announcements/' + deleteTarget.id + '/remove',
                        body: { expectedRevision: deleteTarget.revision, idempotencyKey: crypto.randomUUID() }
                      });
                  }}
                >
                  {command.unknown ? '重试确认删除' : '删除公告'}
                </Button>
              </div>
            }
          >
            <p>确定删除这条公告？删除后将不再展示。</p>
            <blockquote className="announcement-delete-preview">{deleteTarget?.text}</blockquote>
            {command.unknown ? <p role="alert">暂时无法确认删除结果，请重试确认同次操作。</p> : null}
          </Modal>
        </>
      )}
    </main>
  );
}
