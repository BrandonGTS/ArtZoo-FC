'use client';
import Image from 'next/image';
import { AdminReturnLink } from '../admin-return-link';
import { useEffect, useState } from 'react';
import { Button, Checkbox, ConfigProvider, Input, Table, Upload } from 'antd';
import type { UploadProps } from 'antd';
type RcFile = Parameters<NonNullable<UploadProps['beforeUpload']>>[0];
import type { ActivityShareMedia, AdminActivityShare } from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../page-heading';
import { ListPagination } from '../collection-controls';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { beijingFull } from '../activities/activity-ui';
import { useSharingCommand, useSharingResource } from './sharing-api';
import './public-sharing.css';

const actionLabels: Record<string, string> = {
  CREATE: '新建活动分享',
  SAVE: '保存回顾',
  FEATURE: '设为精选',
  UNFEATURE: '取消精选'
};
type Result =
  { share: AdminActivityShare; replayed: boolean } | { media: ActivityShareMedia; replayed: boolean };
function validShare(value: unknown): value is AdminActivityShare {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'body' in value &&
    typeof value.body === 'string' &&
    'allMedia' in value &&
    Array.isArray(value.allMedia) &&
    'media' in value &&
    Array.isArray(value.media) &&
    'audits' in value &&
    Array.isArray(value.audits)
  );
}
export default function ShareEditor({ id, activityId }: { id?: string; activityId?: string }) {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  if (loading || !actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.adminRole)) return null;
  return (
    <OwnedEditor
      key={[actor.id, actor.membership, actor.adminRole, id ?? activityId].join(':')}
      initialId={id}
      activityId={activityId}
    />
  );
}
function OwnedEditor({ initialId, activityId }: { initialId?: string; activityId?: string }) {
  const [id, setId] = useState(initialId),
    [reload, setReload] = useState(0),
    [historyPage, setHistoryPage] = useState(1),
    [locked, setLocked] = useState(false),
    [generation, setGeneration] = useState(0);
  const [anchor, setAnchor] = useState<AdminActivityShare | null>(null),
    [replacing, setReplacing] = useState(false),
    [remoteRevision, setRemoteRevision] = useState(0),
    { notify, contextHolder } = useFeedbackMessage();
  const resource = useSharingResource<AdminActivityShare>(
    id ? '/api/activity-shares/' + id + '?manage=1&historyPage=' + historyPage + '&refresh=' + reload : null,
    'admin',
    true,
    !locked
  );
  const inaccessible = Boolean(
    resource.errorCode && ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(resource.errorCode)
  );
  // Background reads may update history and signal a conflict, but never replace an editing baseline.
  if (inaccessible && anchor) setAnchor(null);
  if (inaccessible && remoteRevision) setRemoteRevision(0);
  if (!inaccessible && resource.data && resource.data.revision > remoteRevision)
    setRemoteRevision(resource.data.revision);
  if (!inaccessible && !anchor && resource.data) setAnchor(resource.data);
  if (replacing && !resource.loading) {
    setReplacing(false);
    if (!resource.error && resource.data) {
      setAnchor(resource.data);
      setGeneration((value) => value + 1);
    }
  }
  const doc = inaccessible ? null : (anchor ?? resource.data);
  const history = resource.data && doc && resource.data.revision >= doc.revision ? resource.data : doc;
  function saved(share: AdminActivityShare) {
    setAnchor(share);
    setRemoteRevision(share.revision);
    setHistoryPage(1);
    setReload((value) => value + 1);
  }
  function replace() {
    if (locked) return;
    setReplacing(true);
    setReload((value) => value + 1);
  }
  return (
    <main className="home-content sharing-editor-content" id="main-content">
      {contextHolder}
      <div className="sharing-section-heading">
        <PageHeading level={1} decoration="burger">
          {id ? '编辑活动分享' : '创建活动分享'}
        </PageHeading>
        <AdminReturnLink disabled={locked} />
      </div>
      {resource.error ? (
        <div className="sharing-read-error">
          <ErrorNotice message={resource.error} />
          <Button disabled={locked || resource.loading} onClick={() => setReload((value) => value + 1)}>
            重试读取
          </Button>
        </div>
      ) : null}
      {!id ? (
        <CreateShare
          activityId={activityId}
          notify={notify}
          onLock={setLocked}
          created={(share) => {
            setAnchor(share);
            setId(share.id);
          }}
        />
      ) : doc ? (
        <EditShare
          key={doc.id + ':' + doc.revision + ':' + generation}
          share={doc}
          historyShare={history ?? doc}
          remoteRevision={Math.max(remoteRevision, resource.data?.revision ?? doc.revision)}
          replacing={replacing}
          historyPage={historyPage}
          historyLoading={resource.loading}
          onHistory={setHistoryPage}
          notify={notify}
          onLock={setLocked}
          saved={saved}
          refresh={replace}
        />
      ) : resource.loading ? (
        <p role="status">正在读取活动分享…</p>
      ) : null}
    </main>
  );
}
type Common = { notify(type: 'success' | 'error', content: string): void; onLock(value: boolean): void };
function CreateShare({
  activityId,
  created,
  notify,
  onLock
}: Common & { activityId?: string; created(share: AdminActivityShare): void }) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const command = useSharingCommand<{ share: AdminActivityShare; replayed: boolean }>({
    notify,
    success(result) {
      if (!validShare(result?.share)) throw new Error('Invalid response');
      created(result.share);
      notify('success', '已创建活动分享');
    }
  });
  useEffect(() => {
    onLock(command.locked);
    return () => onLock(false);
  }, [command.locked, onLock]);
  return (
    <section className="paper-panel paper-activity sharing-editor-panel">
      <div className="sharing-form">
        <label htmlFor="share-create-title">
          分享标题
          <Input
            autoComplete="off"
            id="share-create-title"
            value={title}
            maxLength={100}
            disabled={command.locked}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label htmlFor="share-create-body">
          公开回顾
          <Input.TextArea
            autoComplete="off"
            id="share-create-body"
            value={body}
            rows={8}
            maxLength={2000}
            disabled={command.locked}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {!activityId ? <p>请从活动详情选择要分享的活动。</p> : null}
        <ErrorNotice
          message={
            command.unknown
              ? '创建可能已成功，当前结果尚未确认。请使用“重试确认创建”沿用原请求确认结果。'
              : null
          }
        />
        <div className="sharing-actions">
          {command.unknown ? (
            <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
              重试确认创建
            </Button>
          ) : (
            <Button
              type="primary"
              loading={command.busy}
              disabled={!activityId}
              onClick={() =>
                void command.submit({
                  kind: 'json',
                  path: '/api/activity-shares',
                  body: { activityId, title, body, idempotencyKey: crypto.randomUUID() }
                })
              }
            >
              创建回顾
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
function EditShare({
  share,
  historyShare,
  remoteRevision,
  replacing,
  historyPage,
  historyLoading,
  onHistory,
  notify,
  onLock,
  saved,
  refresh
}: Common & {
  share: AdminActivityShare;
  historyShare: AdminActivityShare;
  remoteRevision: number;
  replacing: boolean;
  historyPage: number;
  historyLoading: boolean;
  onHistory(page: number): void;
  saved(share: AdminActivityShare): void;
  refresh(): void;
}) {
  const [title, setTitle] = useState(share.title),
    [body, setBody] = useState(share.body),
    [reason, setReason] = useState('');
  const [allMedia, setAllMedia] = useState(share.allMedia),
    [selected, setSelected] = useState(share.media.map((media) => media.id));
  const [conflicted, setConflicted] = useState(false),
    [active, setActive] = useState<string | null>(null),
    [preview, setPreview] = useState<ActivityShareMedia | null>(null);
  const command = useSharingCommand<Result>({
    notify,
    success(result, request) {
      if (request.kind === 'upload') {
        if (!('media' in result) || !result.media?.id) throw new Error('Invalid response');
        setAllMedia((current) =>
          current.some((media) => media.id === result.media.id) ? current : [...current, result.media]
        );
        notify('success', '配图已上传');
      } else {
        if (!('share' in result) || !validShare(result.share)) throw new Error('Invalid response');
        saved(result.share);
        notify('success', (actionLabels[String(request.body.action)] ?? '操作') + '成功');
      }
    },
    failure(code) {
      if (code === 'CONFLICT') setConflicted(true);
    }
  });
  useEffect(() => {
    onLock(command.locked);
    return () => onLock(false);
  }, [command.locked, onLock]);
  const notice = useSharingResource<{ uploadNotice: string | null }>('/api/albums/categories', 'admin');
  const remoteChanged = remoteRevision > share.revision;
  const stale = conflicted || remoteChanged || replacing;
  const dirty =
    title !== share.title ||
    body !== share.body ||
    selected.join(',') !== share.media.map((media) => media.id).join(',');
  async function write(action: 'SAVE' | 'FEATURE' | 'UNFEATURE') {
    if (command.locked || stale) return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    if (
      (action === 'FEATURE' || (action === 'SAVE' && share.featuredAt)) &&
      (!title.trim() || !body.trim())
    ) {
      command.setError('请填写完整的分享标题和公开回顾。');
      return;
    }
    if (action === 'FEATURE' && dirty) {
      command.setError('请先保存修改后再设为精选。');
      return;
    }
    setActive(action);
    await command.submit({
      kind: 'json',
      path: '/api/activity-shares/' + share.id,
      body: {
        action,
        expectedRevision: share.revision,
        idempotencyKey: crypto.randomUUID(),
        reason: reason.trim(),
        ...(action === 'SAVE' ? { title, body, mediaIds: selected } : {})
      }
    });
  }
  function upload(file: RcFile) {
    if (command.locked || stale) return Upload.LIST_IGNORE;
    if (file.size > 30 * 1024 * 1024) {
      command.setError('每张图片最多30MiB。');
      return Upload.LIST_IGNORE;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('batchId', crypto.randomUUID());
    form.set('batchIndex', '0');
    setActive('UPLOAD');
    void command.submit({ kind: 'upload', path: '/api/activity-shares/' + share.id + '/upload', form });
    return Upload.LIST_IGNORE;
  }
  return (
    <section className="paper-panel paper-activity sharing-editor-panel">
      <div className="sharing-detail-heading">
        <h2>{share.activity.title}</h2>
        <span className="sharing-meta">{share.featuredAt ? '已精选' : '未精选'}</span>
      </div>
      <div className="sharing-form">
        <label htmlFor="share-title">
          分享标题
          <Input
            autoComplete="off"
            id="share-title"
            value={title}
            maxLength={100}
            disabled={command.locked || stale}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label htmlFor="share-body">
          公开回顾
          <Input.TextArea
            autoComplete="off"
            id="share-body"
            value={body}
            rows={8}
            maxLength={2000}
            disabled={command.locked || stale}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <section className="sharing-media-section">
          <div className="sharing-section-heading">
            <h3>回顾配图</h3>
            <Upload
              accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo"
              showUploadList={false}
              beforeUpload={upload}
              disabled={command.locked || stale}
            >
              <Button loading={command.busy && active === 'UPLOAD'} disabled={command.locked || stale}>
                上传配图
              </Button>
            </Upload>
          </div>
          {notice.data?.uploadNotice ? (
            <p className="album-upload-notice">{notice.data.uploadNotice}</p>
          ) : null}
          <div className="sharing-media-grid">
            {allMedia.map((media, index) => (
              <div key={media.id} className="sharing-media-option">
                <Button
                  type="text"
                  className="sharing-media-preview"
                  aria-label={'预览配图 ' + (index + 1)}
                  disabled={command.locked}
                  onClick={() => setPreview(media)}
                >
                  <Image
                    unoptimized
                    src={media.thumbnailUrl}
                    width={media.width}
                    height={media.height}
                    alt={'回顾配图 ' + (index + 1)}
                  />
                </Button>
                <Checkbox
                  disabled={command.locked || stale}
                  checked={selected.includes(media.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, media.id] : current.filter((id) => id !== media.id)
                    )
                  }
                >
                  选入回顾
                </Checkbox>
              </div>
            ))}
          </div>
        </section>
        <label htmlFor="share-reason">
          操作原因
          <Input.TextArea
            autoComplete="off"
            id="share-reason"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={command.locked || stale}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {remoteChanged ? <ErrorNotice message="活动分享已更新，重新读取将放弃未保存的修改。" /> : null}
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
          ) : stale ? (
            <Button loading={replacing} disabled={replacing} onClick={refresh}>
              重新读取活动分享
            </Button>
          ) : (
            <>
              <Button
                disabled={command.locked}
                loading={command.busy && active === 'SAVE'}
                onClick={() => void write('SAVE')}
              >
                {share.featuredAt ? '保存并更新公开内容' : '保存回顾'}
              </Button>
              {share.featuredAt ? (
                <Button
                  danger
                  disabled={command.locked}
                  loading={command.busy && active === 'UNFEATURE'}
                  onClick={() => void write('UNFEATURE')}
                >
                  取消精选
                </Button>
              ) : (
                <Button
                  type="primary"
                  disabled={command.locked}
                  loading={command.busy && active === 'FEATURE'}
                  onClick={() => void write('FEATURE')}
                >
                  设为精选
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <ShareAudits
        share={historyShare}
        loading={historyLoading}
        page={historyPage}
        disabled={command.locked || replacing}
        onChange={onHistory}
      />
      {preview ? (
        <div className="sharing-preview">
          <div className="sharing-section-heading">
            <h3>配图预览</h3>
            <Button onClick={() => setPreview(null)}>关闭预览</Button>
          </div>
          <Image
            unoptimized
            src={preview.previewUrl}
            width={preview.width}
            height={preview.height}
            alt="回顾配图预览"
          />
        </div>
      ) : null}
    </section>
  );
}
export function ShareAudits({
  share,
  loading,
  page,
  disabled,
  onChange
}: {
  share: AdminActivityShare;
  loading?: boolean;
  page: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  return (
    <section className="sharing-audits">
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
          loading={loading}
          dataSource={share.audits}
          pagination={false}
          scroll={{ x: 500 }}
          locale={{ emptyText: '暂无操作记录' }}
          columns={[
            {
              title: '时间 / 操作人',
              key: 'actor',
              render: (_, row) => (
                <span>
                  {beijingFull(row.createdAt)} · {row.actor.displayName ?? '管理员'}
                </span>
              )
            },
            { title: '操作', dataIndex: 'action', render: (value: string) => actionLabels[value] ?? value },
            { title: '原因', dataIndex: 'reason' }
          ]}
        />
      </ConfigProvider>
      <ListPagination
        page={page}
        totalPages={Math.ceil(share.historyTotal / 20)}
        loading={loading || disabled}
        onPageChange={onChange}
        label="操作记录分页"
      />
    </section>
  );
}
