import StickerPicker, { useStickerInput } from '../stickers/sticker-picker';
import InlineStickerInput from '../stickers/inline-sticker-input';
import type { DiscussionTransport } from './discussion-transport';
import { useEffect, useRef, useState } from 'react';
import { Button, Upload, type UploadFile } from 'antd';
import { AccountApiError, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import MentionInput, { activeMentions } from './mention-input';
import { dailyError, useDailyCommand } from './use-command';
import DailyToolbarIcon from './daily-toolbar-icon';

const accept = '.jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo';
export default function DailyReplyComposer({
  postId,
  parentId = null,
  replyName,
  onCancelReply,
  onSaved,
  onPublished,
  onLockedChange,
  disabled = false,
  autoFocus = false,
  submitLabel = '发表评论',
  compactTools = false,
  inputId,
  transport
}: {
  postId: string;
  parentId?: string | null;
  replyName?: string;
  onCancelReply?(): void;
  inputId?: string;
  transport?: DiscussionTransport;
  compactTools?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  submitLabel?: string;
  onSaved(): Promise<void>;
  onPublished?(): void;
  onLockedChange?(locked: boolean): void;
}) {
  const [body, setBody] = useState(''),
    [mentions, setMentions] = useState<string[]>([]);
  const [files, setFiles] = useState<UploadFile[]>([]),
    [preparing, setPreparing] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useDailyCommand(),
    { notify, contextHolder } = useFeedbackMessage();
  const live = useRef(false),
    pending = useRef(false),
    committed = useRef(false);
  const batches = useRef(new Map<string, { id: string; index: number }>());
  const uploaded = useRef(new Map<string, string>());
  const busy = preparing || command.busy,
    locked = disabled || busy || command.uncertain || refreshPending;
  const stickerInput = useStickerInput(locked);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    onLockedChange?.(locked);
  }, [locked, onLockedChange]);

  async function upload(file: UploadFile) {
    const cached = uploaded.current.get(file.uid);
    if (cached) return cached;
    const batch = batches.current.get(file.uid);
    if (!batch) throw new Error('图片选取状态已变化，请重新选择');
    const form = new FormData();
    form.set('file', file.originFileObj ?? (file as unknown as File));
    form.set('batchId', batch.id);
    form.set('batchIndex', String(batch.index));
    let response: Response;
    try {
      response = await fetch(transport?.uploadUrl ?? '/api/daily/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-ArtZoo-Request': '1' },
        body: form,
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      throw new Error('图片上传响应中断，已选图片仍保留，请重试。');
    }
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new AccountApiError(result.error ?? { code: 'SERVICE_UNAVAILABLE', message: '图片上传失败' });
    uploaded.current.set(file.uid, result.data.id);
    return result.data.id as string;
  }
  async function submit() {
    if (!live.current || pending.current) return;
    const draftBody = stickerInput.read();
    if (draftBody === null) return;
    pending.current = true;
    setPreparing(true);
    setError(null);
    try {
      let result;
      if (committed.current) result = true;
      else if (command.uncertain) result = await command.retry();
      else {
        const draft = { body: draftBody, mentions, parentId, files: [...files] },
          mediaIds: string[] = [];
        for (const file of draft.files) {
          if (!live.current) return;
          mediaIds.push(await upload(file));
        }
        if (!live.current) return;
        result = await command.send(transport?.createUrl ?? '/api/daily/' + postId + '/comments', {
          body: draft.body,
          mentions: await activeMentions(draft.body, draft.mentions),
          parentId: draft.parentId,
          mediaIds,
          ...transport?.scopeBody
        });
      }
      if (result && live.current) {
        if (!committed.current) {
          committed.current = true;
          setRefreshPending(true);
          setBody('');
          setMentions([]);
          setFiles([]);
          uploaded.current.clear();
          batches.current.clear();
          if (onPublished) onPublished();
          else notify('success', '评论已发布');
        }
        await onSaved();
        committed.current = false;
        if (live.current) setRefreshPending(false);
      }
    } catch (failure) {
      if (live.current) {
        if (committed.current) setError('评论已发布，列表刷新失败，请点击“刷新评论”重试。');
        else if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(failure).code))
          setError(dailyError(failure));
        else notify('error', dailyError(failure));
      }
    } finally {
      pending.current = false;
      if (live.current) setPreparing(false);
    }
  }
  return (
    <div className="daily-comment-form" data-home-card-independent>
      {contextHolder}
      {replyName ? (
        <div className="daily-actions">
          <span>回复 {replyName}</span>
          {onCancelReply ? (
            <Button type="link" disabled={locked} onClick={onCancelReply}>
              取消回复
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="daily-error">
          {command.uncertain ? '暂未确认评论结果，请重试。' : error}
        </p>
      ) : null}
      <InlineStickerInput
        {...stickerInput.inputProps}
        id={inputId ?? 'daily-comment-input-' + postId}
        aria-label="评论正文"
        placeholder="发表评论"
        value={body}
        disabled={locked}
        maxLength={2000}
        onChange={setBody}
        minRows={3}
        maxRows={10}
        autoFocus={autoFocus}
      />
      <div className={'daily-composer-footer' + (compactTools ? ' daily-composer-footer-compact' : '')}>
        <div className={'daily-composer-tools' + (compactTools ? ' daily-composer-icon-tools' : '')}>
          <Upload
            accept={accept}
            multiple
            fileList={files}
            disabled={locked}
            classNames={
              compactTools
                ? {
                    root: 'daily-comment-upload',
                    trigger: 'daily-comment-upload-trigger',
                    list: 'daily-comment-file-list'
                  }
                : undefined
            }
            showUploadList={compactTools ? files.length > 0 : undefined}
            beforeUpload={(file, selection) => {
              if (selection.length > 10 || files.length + selection.length > 10) {
                if (file.uid === selection[0]!.uid) setError('每次最多选择10张图片');
                return Upload.LIST_IGNORE;
              }
              if (file.size > 30 * 1024 * 1024) {
                setError('每张图片最多30MiB');
                return Upload.LIST_IGNORE;
              }
              let batch = batches.current.get(selection[0]!.uid);
              if (!batch) {
                batch = { id: crypto.randomUUID(), index: 0 };
                batches.current.set(selection[0]!.uid, batch);
              }
              batches.current.set(file.uid, {
                id: batch.id,
                index: selection.findIndex((item) => item.uid === file.uid)
              });
              return false;
            }}
            onChange={(info) => setFiles(info.fileList)}
          >
            <Button
              type={compactTools ? 'text' : 'default'}
              disabled={locked}
              aria-label="添加评论图片"
              icon={compactTools ? <DailyToolbarIcon kind="photo" /> : undefined}
            >
              {compactTools ? null : '图片'}
            </Button>
          </Upload>
          <MentionInput
            compact={compactTools}
            disabled={locked}
            popupClassName="daily-mention-popup"
            onChange={(label, id) => {
              setBody(
                (current) => current + (current && !/\s$/.test(current) ? ' ' : '') + '@' + label + ' '
              );
              setMentions((current) => Array.from(new Set([...current, id])));
            }}
          />
          <StickerPicker
            compact={compactTools}
            disabled={locked}
            onSelect={stickerInput.insert}
            onClosed={stickerInput.restore}
          />
        </div>
        <Button
          type="primary"
          loading={busy}
          disabled={
            disabled || busy || (!refreshPending && !command.uncertain && !body.trim() && !files.length)
          }
          onClick={() => void submit()}
        >
          {refreshPending ? '刷新评论' : command.uncertain ? '重试评论' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
