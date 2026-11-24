'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import homeStyles from '../home/home-preview.module.css';
import DailyPreviewEditor, { type DailyPreviewSubmission } from './daily-preview-editor';
import styles from './daily-preview.module.css';

const surfaceSelector = '[data-preview-page="daily"], [role="dialog"]';
const blankSelector = [
  surfaceSelector,
  '.ant-modal-container',
  '.ant-modal-body',
  '.' + homeStyles.pageHeader,
  '.' + styles.hero,
  '.' + styles.daily,
  '.' + styles.posts,
  '.' + styles.postDetail,
  '.' + styles.replySection,
  '.' + styles.replyList,
  '.' + styles.replyItem
].join(', ');

export default function DailyPreviewComposer({
  active = true,
  onPublish,
  variant = 'share'
}: {
  active?: boolean;
  onPublish(submission: DailyPreviewSubmission): void;
  variant?: 'share' | 'reply';
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const nextDraft = useRef(0);
  const keepDraft = useRef(false);
  const returnFocus = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLButtonElement>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const editorId = useId();

  function open() {
    if (!keepDraft.current) setDraft(++nextDraft.current);
    setExpanded(true);
  }

  function discardAndClose() {
    keepDraft.current = false;
    returnFocus.current = true;
    setExpanded(false);
  }

  useEffect(() => {
    if (!active || !expanded) return;

    const container = containerRef.current;
    const surface = container?.closest(surfaceSelector);
    if (!container || !(surface instanceof HTMLElement)) return;

    let pressedBlank: Element | null = null;
    let editorHadFocus = false;

    const trackPress = (event: PointerEvent) => {
      const target = event.target;
      pressedBlank =
        event.button === 0 &&
        target instanceof Element &&
        target.matches(blankSelector) &&
        !container.contains(target) &&
        target.closest(surfaceSelector) === surface
          ? target
          : null;
      editorHadFocus = container.contains(container.ownerDocument.activeElement);
    };

    const closeOnBlank = (event: MouseEvent) => {
      const clickedBlank = event.detail > 0 && pressedBlank !== null && event.target === pressedBlank;
      pressedBlank = null;
      if (!clickedBlank) return;

      keepDraft.current = true;
      returnFocus.current = editorHadFocus;
      setExpanded(false);
    };

    surface.addEventListener('pointerdown', trackPress, true);
    surface.addEventListener('click', closeOnBlank, true);
    return () => {
      surface.removeEventListener('pointerdown', trackPress, true);
      surface.removeEventListener('click', closeOnBlank, true);
    };
  }, [active, expanded]);

  useLayoutEffect(() => {
    if (expanded || draft === null) return;
    if (returnFocus.current) promptRef.current?.focus({ preventScroll: true });
    if (keepDraft.current) return;

    const transitions = editorPanelRef.current?.getAnimations() ?? [];
    let reopened = false;
    void Promise.allSettled(transitions.map((transition) => transition.finished)).then(() => {
      if (!reopened) setDraft(null);
    });

    return () => {
      reopened = true;
    };
  }, [expanded, draft]);

  return (
    <div
      ref={containerRef}
      className={variant === 'reply' ? styles.replyComposer : styles.publisher}
      data-expanded={expanded ? '' : undefined}
    >
      <div className={styles.publisherPanel} data-visible={!expanded ? '' : undefined} inert={expanded}>
        <div className={styles.publisherPanelContent}>
          <button
            className={styles.publisherPrompt}
            type="button"
            aria-controls={editorId}
            aria-expanded={expanded}
            onClick={open}
            ref={promptRef}
          >
            说点什么吧
          </button>
        </div>
      </div>

      <div
        id={editorId}
        className={styles.publisherPanel}
        data-visible={expanded ? '' : undefined}
        inert={!expanded}
        ref={editorPanelRef}
      >
        <div className={styles.publisherPanelContent}>
          {draft !== null && (
            <DailyPreviewEditor
              key={draft}
              variant={variant}
              active={active && expanded}
              onCancel={discardAndClose}
              onPublish={(submission) => {
                onPublish(submission);
                discardAndClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
