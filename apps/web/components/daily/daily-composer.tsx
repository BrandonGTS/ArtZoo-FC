import StickerPicker, { useStickerInput } from '../stickers/sticker-picker';
import InlineStickerInput from '../stickers/inline-sticker-input';
import { useEffect, useRef, useState } from 'react';
import { Button, Upload, Image, type UploadFile } from 'antd';
import type { DailyPostView } from '../../server/daily/contract';
import { AccountApiError, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import MentionInput, { activeMentions } from './mention-input';
import DailyToolbarIcon from './daily-toolbar-icon';
import { useDailyCommand, dailyError } from './use-command';
const accept = '.jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo';
export default function DailyComposer({
  post,
  onSaved,
  onCancel,
  onLockedChange,
  variant = 'default',
  autoFocus = false
}: {
  post?: DailyPostView;
  onSaved(id: string): Promise<void>;
  onCancel?(): void;
  onLockedChange?(locked: boolean): void;
  variant?: 'default' | 'feed';
  autoFocus?: boolean;
}) {
  const compact = variant === 'feed';
  const { notify, contextHolder } = useFeedbackMessage();
  const [body, setBody] = useState(post?.body ?? ''),
    [mentions, setMentions] = useState(post?.mentions ?? []);
  const [files, setFiles] = useState<UploadFile[]>([]),
    [existing, setExisting] = useState(post?.media ?? []);
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);
  const live = useRef(false),
    pending = useRef(false),
    committed = useRef<string | null>(null);
  const batch = useRef(new Map<string, { id: string; index: number }>()),
    uploaded = useRef(new Map<string, string>());
  const command = useDailyCommand(),
    busy = uploading || command.busy,
    locked = busy || command.uncertain || refreshPending;
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
  useEffect(() => () => onLockedChange?.(false), [onLockedChange]);
  async function upload(file: UploadFile) {
    const cached = uploaded.current.get(file.uid);
    if (cached) return cached;
    const fields = batch.current.get(file.uid);
    if (!fields) throw new Error('图片选取状态已变化，请重新选择');
    const form = new FormData();
    form.set('file', file.originFileObj ?? (file as unknown as File));
    form.set('batchId', fields.id);
    form.set('batchIndex', String(fields.index));
    let response: Response;
    try {
      response = await fetch('/api/daily/upload', {
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
    setUploading(true);
    setError(null);
    try {
      let result: { id: string } | undefined = committed.current ? { id: committed.current } : undefined;
      if (!result && command.uncertain) result = await command.retry<{ id: string }>();
      else if (!result) {
        const mediaIds = existing.map((item) => item.id);
        for (let i = 0; i < files.length; i++) {
          if (!live.current) return;
          setProgress(`正在上传图片 ${i + 1}/${files.length}`);
          mediaIds.push(await upload(files[i]!));
        }
        if (!live.current) return;
        setProgress('');
        result = await command.send<{ id: string }>(
          post ? '/api/daily/' + post.id : '/api/daily',
          {
            body: draftBody,
            mentions: await activeMentions(draftBody, mentions),
            mediaIds,
            ...(post ? { revision: post.revision } : {})
          },
          post ? 'PATCH' : 'POST'
        );
      }
      if (result && live.current) {
        committed.current = result.id;
        setRefreshPending(true);
        await onSaved(result.id);
        if (live.current) {
          setBody('');
          setMentions([]);
          setFiles([]);
          setExisting([]);
          uploaded.current.clear();
          batch.current.clear();
          committed.current = null;
          setRefreshPending(false);
        }
      }
    } catch (failure) {
      if (live.current) {
        if (committed.current) setError('动态已保存，列表刷新失败，请重试刷新。');
        else if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(failure).code))
          setError(dailyError(failure));
        else notify('error', dailyError(failure));
      }
    } finally {
      pending.current = false;
      if (live.current) {
        setUploading(false);
        setProgress('');
      }
    }
  }
  const submitButton = (
    <Button
      type="primary"
      loading={busy}
      disabled={
        busy || (!refreshPending && !command.uncertain && !body.trim() && !files.length && !existing.length)
      }
      onClick={() => void submit()}
    >
      {refreshPending
        ? '刷新动态'
        : command.uncertain
          ? '重试保存'
          : post
            ? '保存修改'
            : compact
              ? '发布'
              : '发布动态'}
    </Button>
  );
  const cancelButton = onCancel ? (
    <Button className={compact ? 'daily-composer-cancel' : undefined} disabled={locked} onClick={onCancel}>
      取消
    </Button>
  ) : null;
  return (
    <div className={'daily-composer' + (compact ? ' daily-feed-composer' : '')} data-home-card-independent>
      {contextHolder}
      {error ? (
        <p role="alert" className="daily-error">
          {command.uncertain ? '暂未确认保存结果，请重试。' : error}
        </p>
      ) : null}
      <InlineStickerInput
        {...stickerInput.inputProps}
        autoFocus={autoFocus}
        aria-label={post ? '编辑动态正文' : '动态正文'}
        placeholder="分享近况、吐槽或一个小想法……"
        value={body}
        onChange={setBody}
        disabled={locked}
        maxLength={10000}
        minRows={compact ? 3 : 2}
        maxRows={12}
      />
      {existing.length ? (
        <div className="daily-edit-media">
          {existing.map((media) => (
            <div key={media.id}>
              <Image src={media.thumbnailUrl} alt="已选图片" width={100} />
              <Button
                disabled={locked}
                onClick={() => setExisting((current) => current.filter((item) => item.id !== media.id))}
              >
                移除图片
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={'daily-composer-footer' + (compact ? ' daily-composer-footer-compact' : '')}>
        <div className={'daily-composer-tools' + (compact ? ' daily-composer-icon-tools' : '')}>
          <Upload
            accept={accept}
            multiple
            fileList={files}
            disabled={locked}
            classNames={
              compact
                ? {
                    root: 'daily-comment-upload',
                    trigger: 'daily-comment-upload-trigger',
                    list: 'daily-comment-file-list'
                  }
                : undefined
            }
            beforeUpload={(file, selection) => {
              if (selection.length > 10 || files.length + existing.length + selection.length > 10) {
                if (file.uid === selection[0]!.uid) setError('每次最多选择10张图片');
                return Upload.LIST_IGNORE;
              }
              if (file.size > 30 * 1024 * 1024) {
                setError('每张图片最多30MiB');
                return Upload.LIST_IGNORE;
              }
              let selected = batch.current.get(selection[0]!.uid);
              if (!selected) {
                selected = { id: crypto.randomUUID(), index: 0 };
                batch.current.set(selection[0]!.uid, selected);
              }
              batch.current.set(file.uid, {
                id: selected.id,
                index: selection.findIndex((item) => item.uid === file.uid)
              });
              return false;
            }}
            onChange={(info) => setFiles(info.fileList)}
          >
            <Button
              type={compact ? 'text' : 'default'}
              disabled={locked}
              aria-label="添加动态图片"
              icon={compact ? <DailyToolbarIcon kind="photo" /> : undefined}
            >
              {compact ? null : '图片 / 动图'}
            </Button>
          </Upload>
          <MentionInput
            compact={compact}
            disabled={locked}
            popupClassName={compact ? 'daily-mention-popup' : undefined}
            onChange={(label, id) => {
              setBody(
                (current) => current + (current && !/\s$/.test(current) ? ' ' : '') + '@' + label + ' '
              );
              setMentions((current) => Array.from(new Set([...current, id])));
            }}
          />
          <StickerPicker
            compact={compact}
            disabled={locked}
            onSelect={stickerInput.insert}
            onClosed={stickerInput.restore}
          />
        </div>
        {compact ? (
          <>
            {cancelButton}
            {submitButton}
          </>
        ) : (
          <div className="daily-actions">
            {cancelButton}
            {submitButton}
          </div>
        )}
      </div>
      {progress ? <p role="status">{progress}</p> : null}
    </div>
  );
}
