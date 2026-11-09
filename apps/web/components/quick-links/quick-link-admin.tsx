'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Upload } from 'antd';
import type { QuickLinkList, QuickLinkView, QuickLinkResult } from '../../server/quick-links/contract';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../page-heading';
import { AdminReturnLink } from '../admin-return-link';
import { CollectionSearch, ListPagination } from '../collection-controls';
import { useSharingCommand, useSharingResource } from '../public-sharing/sharing-api';
import { useFeedbackMessage } from '../use-feedback-message';
import { ActivityPaper } from '../activities/activity-ui';
import { quickLinksChanged, useQuickLinkRevision } from './quick-link-data';
import QuickLinkIcon from './quick-link-icon';
import { useQuickLinkOrder } from './quick-link-order';
import { useQuickLinkBatch } from './quick-link-batch';
import './quick-links.css';
export default function QuickLinkAdmin() {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  if (loading || !actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.adminRole)) return null;
  const owner = [actor.id, actor.membership, actor.adminRole].join(':');
  return <OwnedQuickLinkAdmin key={owner} owner={owner} />;
}
function OwnedQuickLinkAdmin({ owner }: { owner: string }) {
  const [input, setInput] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [denied, setDenied] = useState(false),
    [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<{
      item: QuickLinkView | null;
      expectedRevision: number;
      name: string;
      url: string;
    } | null>(null),
    [removing, setRemoving] = useState<{ item: QuickLinkView; expectedRevision: number } | null>(null);
  const [icon, setIcon] = useState<{ file: File; preview: string } | null>(null);
  const iconRef = useRef<typeof icon>(null),
    commandLock = useRef(false);
  useEffect(
    () => () => {
      if (iconRef.current) URL.revokeObjectURL(iconRef.current.preview);
      iconRef.current = null;
    },
    []
  );
  const clearIcon = () => {
    if (iconRef.current) URL.revokeObjectURL(iconRef.current.preview);
    iconRef.current = null;
    setIcon(null);
  };
  const closeEditor = () => {
    clearIcon();
    setEditor(null);
  };
  const { notify, contextHolder } = useFeedbackMessage(),
    revision = useQuickLinkRevision();
  const batch = useQuickLinkBatch({
    notify,
    changed() {
      setPage(1);
      setInput('');
      setQuery('');
      setReload((value) => value + 1);
      quickLinksChanged();
    },
    denied() {
      setDenied(true);
      setAdding(false);
    }
  });
  const command = useSharingCommand<QuickLinkResult>({
    notify,
    success(result, request) {
      if (!result.id || !Number.isSafeInteger(result.revision)) throw Error('Invalid result');
      if (request.kind === 'json' && request.body.action === 'create') {
        setPage(1);
        setInput('');
        setQuery('');
      }
      closeEditor();
      setRemoving(null);
      setReload((value) => value + 1);
      quickLinksChanged();
      notify('success', result.replayed ? '已确认操作结果' : '已更新快捷入口');
    },
    failure(code) {
      if (['UNAUTHENTICATED', 'FORBIDDEN'].includes(code)) {
        setDenied(true);
        closeEditor();
        setRemoving(null);
      }
      if (code === 'CONFLICT') {
        setReload((value) => value + 1);
        closeEditor();
        setRemoving(null);
      }
    }
  });
  const resource = useSharingResource<QuickLinkList>(
    denied
      ? null
      : `/api/admin/quick-links?page=${page}&pageSize=20&query=${encodeURIComponent(query)}&fresh=${reload}-${revision}`,
    owner,
    false,
    !command.locked && !batch.locked && !adding && !editor && !removing
  );
  const data = resource.data,
    blocked = denied || ['UNAUTHENTICATED', 'FORBIDDEN'].includes(resource.errorCode ?? ''),
    locked = command.locked || batch.locked;
  useEffect(() => {
    commandLock.current = locked;
  });
  const search = (value: string) => {
    setQuery(value.trim());
    setPage(1);
    setReload((value) => value + 1);
  };
  const submit = (body: Record<string, unknown>) => {
    if (commandLock.current || blocked) return;
    commandLock.current = true;
    const frozen = { ...body, idempotencyKey: crypto.randomUUID() };
    if (body.action === 'update' && iconRef.current) {
      const form = new FormData();
      form.append('command', JSON.stringify(frozen));
      form.append('file', iconRef.current.file);
      void command.submit({ kind: 'upload', path: '/api/admin/quick-links/icon', form });
    } else void command.submit({ kind: 'json', path: '/api/admin/quick-links', body: frozen });
  };
  const chooseIcon = (file: File) => {
    if (commandLock.current || blocked || !editor) return false;
    const extensions: Record<string, RegExp> = {
      'image/png': /\.png$/i,
      'image/jpeg': /\.jpe?g$/i,
      'image/webp': /\.webp$/i
    };
    if (!extensions[file.type]?.test(file.name)) {
      notify('error', '请选择 PNG、JPEG 或 WebP 静态图片');
      return false;
    }
    if (file.size === 0) {
      notify('error', '图标不能为空');
      return false;
    }
    if (file.size > 2 * 1024 * 1024) {
      notify('error', '图标不能超过2 MiB');
      return false;
    }
    const selection = { file, preview: URL.createObjectURL(file) };
    if (iconRef.current) URL.revokeObjectURL(iconRef.current.preview);
    iconRef.current = selection;
    setIcon(selection);
    return false;
  };
  const order = useQuickLinkOrder(
    data?.items ?? [],
    locked || resource.loading || blocked || !!query || !!editor || !!removing || adding,
    [data?.revision, page, query, revision].join(':'),
    (item, targetId) => {
      if (data)
        submit({
          action: 'move',
          id: item.id,
          revision: item.revision,
          expectedRevision: data.revision,
          targetId
        });
    },
    (item, direction) => {
      if (data)
        submit({
          action: 'move',
          id: item.id,
          revision: item.revision,
          expectedRevision: data.revision,
          direction
        });
    },
    data?.total ?? 0
  );
  const interacting = locked || !!order.activeId;
  return (
    <main className="home-content quick-links-admin" id="main-content">
      {contextHolder}
      <div className="quick-links-heading">
        <PageHeading level={1} decoration="burger">
          快捷入口管理
        </PageHeading>
        <AdminReturnLink />
      </div>
      {blocked ? (
        <p role="alert">无权访问快捷入口管理</p>
      ) : (
        <ActivityPaper className="quick-links-admin-paper">
          <CollectionSearch
            query={input}
            onQueryChange={setInput}
            onSearch={search}
            onClear={() => {
              setInput('');
              search('');
            }}
            searchLabel="搜索管理快捷入口"
            placeholder="搜索网站"
            disabled={interacting || adding || !!editor || !!removing}
          />
          {resource.error ? (
            <p role="alert">
              {resource.error}
              <Button type="text" disabled={locked} onClick={() => setReload((value) => value + 1)}>
                重新读取
              </Button>
            </p>
          ) : null}
          <div className="quick-links-admin-list" aria-busy={resource.loading}>
            {!resource.loading && data?.items.length === 0 ? <p>暂无快捷入口</p> : null}
            {data?.items.map((item) => (
              <div
                className={
                  'quick-links-admin-item' + (order.activeId === item.id ? ' quick-link-dragging' : '')
                }
                data-quick-link-id={item.id}
                style={{ order: order.items.findIndex((row) => row.id === item.id) }}
                key={item.id}
              >
                <Button
                  type="text"
                  className="quick-link-order"
                  aria-label={
                    '排序' +
                    item.name +
                    '，空格选中，方向键移动，回车确认，Esc取消，Alt加上下方向键逐项跨页移动'
                  }
                  aria-keyshortcuts="Space Enter ArrowUp ArrowDown Escape Alt+ArrowUp Alt+ArrowDown"
                  aria-pressed={order.activeId === item.id}
                  title={query ? '搜索时不可调整顺序' : '拖动排序'}
                  disabled={
                    locked ||
                    resource.loading ||
                    blocked ||
                    !!query ||
                    adding ||
                    !!editor ||
                    !!removing ||
                    (!!order.activeId && order.activeId !== item.id)
                  }
                  {...order.bindings(item)}
                >
                  <GripIcon />
                </Button>
                <Button
                  type="text"
                  className="quick-link-edit"
                  aria-label={'编辑' + item.name}
                  disabled={interacting || resource.loading}
                  onClick={() =>
                    setEditor({ item, expectedRevision: data.revision, name: item.name, url: item.url })
                  }
                >
                  <QuickLinkIcon src={item.icon} />
                  <span>{item.name}</span>
                </Button>
                <div className="quick-link-actions">
                  <Button
                    className="quick-link-modify"
                    aria-label={'修改' + item.name}
                    disabled={interacting || resource.loading}
                    onClick={() => {
                      if (!interacting && !resource.loading)
                        setEditor({ item, expectedRevision: data.revision, name: item.name, url: item.url });
                    }}
                  >
                    修改
                  </Button>
                  <Button
                    danger
                    className="quick-link-delete"
                    disabled={interacting || resource.loading}
                    onClick={() => setRemoving({ item, expectedRevision: data.revision })}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <span className="quick-link-sort-status" role="status" aria-live="polite">
            {order.announcement}
          </span>
          <Button
            type="primary"
            className="quick-link-add"
            aria-label="添加快捷入口"
            disabled={interacting || resource.loading || !data}
            onClick={() => setAdding(true)}
          >
            添加快捷入口
          </Button>
          {data ? (
            <ListPagination
              page={data.page}
              totalPages={data.totalPages}
              loading={interacting || resource.loading}
              onPageChange={setPage}
              label="快捷入口管理分页"
            />
          ) : null}
          {command.unknown && !editor && !removing ? (
            <Button onClick={() => void command.retry()} disabled={command.busy}>
              重试确认操作结果
            </Button>
          ) : null}
        </ActivityPaper>
      )}
      <Modal
        title="编辑快捷入口"
        open={!!editor}
        closable={!locked}
        mask={{ closable: !locked }}
        onCancel={() => {
          if (!commandLock.current) closeEditor();
        }}
        footer={
          <div className="quick-link-modal-actions">
            <Button
              disabled={locked}
              onClick={() => {
                if (!commandLock.current) closeEditor();
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              disabled={command.busy || (!command.unknown && (!editor?.name.trim() || !editor?.url.trim()))}
              onClick={() => {
                if (command.unknown) void command.retry();
                else if (editor)
                  submit({
                    action: editor.item ? 'update' : 'create',
                    ...(editor.item ? { id: editor.item.id, revision: editor.item.revision } : {}),
                    expectedRevision: editor.expectedRevision,
                    name: editor.name,
                    url: editor.url
                  });
              }}
            >
              {command.unknown ? '重试确认保存' : '保存'}
            </Button>
          </div>
        }
      >
        <label className="quick-link-label" htmlFor="quick-link-name">
          名称
        </label>
        <Input
          id="quick-link-name"
          autoComplete="off"
          value={editor?.name ?? ''}
          maxLength={80}
          disabled={locked}
          onChange={(event) =>
            setEditor((previous) => (previous ? { ...previous, name: event.target.value } : null))
          }
        />
        <label className="quick-link-label" htmlFor="quick-link-url">
          URL
        </label>
        <Input
          id="quick-link-url"
          autoComplete="off"
          value={editor?.url ?? ''}
          maxLength={2048}
          disabled={locked}
          onChange={(event) =>
            setEditor((previous) => (previous ? { ...previous, url: event.target.value } : null))
          }
        />
        <label className="quick-link-label" htmlFor="quick-link-icon">
          图标（可选）
        </label>
        <div className="quick-link-icon-picker">
          <QuickLinkIcon src={icon?.preview ?? editor?.item?.icon ?? null} />
          <Upload
            key={editor?.item?.id ?? 'closed'}
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            multiple={false}
            showUploadList={false}
            fileList={[]}
            beforeUpload={() => false}
            onChange={({ file }) => {
              const source = file.originFileObj ?? file;
              if (source instanceof File) chooseIcon(source);
            }}
            disabled={locked || !editor}
          >
            <Button id="quick-link-icon" disabled={locked || !editor}>
              选择图标
            </Button>
          </Upload>
        </div>
      </Modal>
      <Modal
        title="添加快捷入口"
        open={adding}
        closable={!batch.locked}
        mask={{ closable: !batch.locked }}
        onCancel={() => {
          if (!batch.locked) setAdding(false);
        }}
        footer={
          <div className="quick-link-modal-actions">
            <Button disabled={batch.locked} onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button
              type="primary"
              disabled={batch.busy || (!batch.unknown && !batch.text.trim())}
              onClick={() => {
                if (batch.unknown) batch.retry();
                else batch.start();
              }}
            >
              {batch.unknown ? '重试确认添加' : '添加'}
            </Button>
          </div>
        }
      >
        <label className="quick-link-label" htmlFor="quick-link-urls">
          网站地址
        </label>
        <Input.TextArea
          id="quick-link-urls"
          autoComplete="off"
          placeholder="每行一个网址"
          rows={6}
          value={batch.text}
          disabled={batch.locked}
          onChange={(event) => batch.setText(event.target.value)}
        />
        {batch.rows.length ? (
          <ul className="quick-link-batch-results" aria-live="polite">
            {batch.rows.map((row) => (
              <li key={row.key}>
                第{row.line}行：{row.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>
      <Modal
        title="删除快捷入口"
        open={!!removing}
        closable={!locked}
        mask={{ closable: !locked }}
        onCancel={() => {
          if (!locked) setRemoving(null);
        }}
        footer={
          <div className="quick-link-modal-actions">
            <Button disabled={locked} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              danger
              type="primary"
              disabled={command.busy}
              onClick={() => {
                if (command.unknown) void command.retry();
                else if (removing)
                  submit({
                    action: 'remove',
                    id: removing.item.id,
                    revision: removing.item.revision,
                    expectedRevision: removing.expectedRevision
                  });
              }}
            >
              {command.unknown ? '重试确认删除' : '删除'}
            </Button>
          </div>
        }
      >
        <p>确定删除“{removing?.item.name}”？</p>
      </Modal>
    </main>
  );
}
function GripIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      {[7, 12, 17].flatMap((y) => [9, 15].map((x) => <circle key={x + ':' + y} cx={x} cy={y} r="1" />))}
    </svg>
  );
}
