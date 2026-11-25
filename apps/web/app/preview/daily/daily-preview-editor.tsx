'use client';

import dynamic from 'next/dynamic';
import { useEffect, useId, useRef, useState } from 'react';
import DailyToolbarIcon from '../../../components/daily/daily-toolbar-icon';
import type { InlineStickerInputRef } from '../../../components/stickers/inline-sticker-input';
import StickerPicker from '../../../components/stickers/sticker-picker';
import PaperModal from '../../../components/ui/paper-modal';
import styles from './daily-preview.module.css';

const InlineStickerInput = dynamic(() => import('../../../components/stickers/inline-sticker-input'), {
  loading: () => <div className={styles.publisherInputPlaceholder} aria-hidden="true" />
});

const members = ['松枝', '浅湾', '澄叶', '栗子'];

type Attachment = { id: number; name: string };

export type DailyPreviewSubmission = { body: string; photos: number };

export default function DailyPreviewEditor({
  active,
  onCancel,
  onPublish,
  variant = 'share'
}: {
  active: boolean;
  variant?: 'share' | 'reply';
  onCancel(): void;
  onPublish(submission: DailyPreviewSubmission): void;
}) {
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hasRejectedFile, setHasRejectedFile] = useState(false);
  const attachmentFeedbackId = useId();
  const [mentionOpen, setMentionOpen] = useState(false);
  const editorRef = useRef<InlineStickerInputRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextAttachment = useRef(0);

  const isReply = variant === 'reply';
  const canPublish = Boolean(body.trim() || attachments.length);

  useEffect(() => {
    if (active) editorRef.current?.focus();
  }, [active]);

  function publish() {
    if (!active) return;
    const content = editorRef.current ? editorRef.current.read() : body;
    if (content === null) return;
    const hasText = Boolean(content.trim());
    if (!hasText && !attachments.length) return;
    onPublish({ body: hasText ? content : '', photos: attachments.length });
  }

  function addPictures(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    const selected = files
      .filter(
        (file) =>
          file.type.startsWith('image/') ||
          (!file.type && /\.(avif|bmp|gif|jpe?g|mpo|png|tiff?|webp)$/i.test(file.name))
      )
      .map(({ name }) => ({ id: ++nextAttachment.current, name }));
    setHasRejectedFile(selected.length !== files.length);
    if (selected.length) setAttachments((current) => [...current, ...selected]);
    input.value = '';
  }

  function restoreEditorFocus() {
    if (active) editorRef.current?.focus();
  }

  return (
    <form
      className={isReply ? styles.publisherEditor + ' ' + styles.replyEditor : styles.publisherEditor}
      aria-label={isReply ? '发布回复' : '发布分享'}
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        publish();
      }}
    >
      <div className={styles.publisherField}>
        <InlineStickerInput
          ref={editorRef}
          aria-label={isReply ? '回复内容' : '分享内容'}
          autoFocus={active}
          disabled={!active}
          value={body}
          onChange={setBody}
          maxLength={Number.POSITIVE_INFINITY}
          minRows={isReply ? 3 : 5}
        />
        <p id={attachmentFeedbackId} className={styles.attachmentFeedback} role="status">
          {hasRejectedFile ? '请选择图片文件' : ''}
        </p>
      </div>

      {attachments.length > 0 && (
        <ul className={styles.publisherAttachments} aria-label="已选图片">
          {attachments.map(({ id, name }) => (
            <li key={id}>
              <button
                className={styles.removeAttachment}
                type="button"
                aria-label={'移除图片：' + name}
                onClick={() =>
                  setAttachments((current) => current.filter((attachment) => attachment.id !== id))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.publisherFooter}>
        <div className={styles.publisherTools} role="group" aria-label="分享编辑工具">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.mpo"
            multiple
            hidden
            onChange={({ currentTarget }) => addPictures(currentTarget)}
          />
          <button
            className={styles.publisherTool}
            type="button"
            aria-label="添加图片"
            aria-describedby={hasRejectedFile ? attachmentFeedbackId : undefined}
            onClick={() => {
              setHasRejectedFile(false);
              fileInputRef.current?.click();
            }}
          >
            <DailyToolbarIcon kind="photo" />
          </button>
          <button
            className={styles.publisherTool}
            type="button"
            aria-label="@ 用户"
            aria-haspopup="dialog"
            aria-expanded={mentionOpen && active}
            onClick={() => setMentionOpen(true)}
          >
            <DailyToolbarIcon kind="mention" />
          </button>
          <StickerPicker
            className={styles.publisherTool}
            compact
            disabled={!active}
            onSelect={(id) => editorRef.current?.insertSticker(id) ?? false}
            onClosed={restoreEditorFocus}
          />
        </div>
        <div className={styles.publisherActions}>
          <button className={styles.cancelButton} type="button" onClick={onCancel}>
            取消
          </button>
          <button className={styles.publishButton} type="submit" disabled={!active || !canPublish}>
            发布
          </button>
        </div>
      </div>

      <PaperModal
        title="选择要 @ 的成员"
        width={360}
        open={mentionOpen && active}
        footer={null}
        focusable={{ focusTriggerAfterClose: false }}
        afterClose={restoreEditorFocus}
        onCancel={() => setMentionOpen(false)}
      >
        <ul className={styles.mentionList}>
          {members.map((member) => (
            <li key={member}>
              <button
                type="button"
                onClick={() => {
                  if (editorRef.current?.insertText('@' + member + ' ')) setMentionOpen(false);
                }}
              >
                {member}
              </button>
            </li>
          ))}
        </ul>
      </PaperModal>
    </form>
  );
}
