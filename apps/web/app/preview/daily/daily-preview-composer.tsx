'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import DailyPreviewEditor, { type DailyPreviewSubmission } from './daily-preview-editor';
import styles from './daily-preview.module.css';

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
  const editorPress = useRef<PointerEvent | null>(null);
  const editorId = useId();
  const isReply = variant === 'reply';

  function open() {
    if (expanded) return;
    if (!keepDraft.current) setDraft(++nextDraft.current);
    setExpanded(true);
  }

  function discardAndClose() {
    keepDraft.current = false;
    returnFocus.current = true;
    setExpanded(false);
  }

  function publish(submission: DailyPreviewSubmission) {
    onPublish(submission);
    discardAndClose();
  }

  useEffect(() => {
    if (!active || !expanded) return;

    const container = containerRef.current;
    if (!container) return;

    const ownerDocument = container.ownerDocument;
    let outsidePress: PointerEvent | null = null;

    const trackOutsidePress = (event: PointerEvent) => {
      outsidePress = event.button === 0 && !event.composedPath().includes(container) ? event : null;
    };

    const closeOnOutside = (event: MouseEvent) => {
      const press = outsidePress;
      outsidePress = null;
      if (
        event.detail === 0 ||
        !press ||
        press === editorPress.current ||
        event.composedPath().includes(container)
      ) {
        return;
      }

      keepDraft.current = true;
      returnFocus.current = container.contains(ownerDocument.activeElement);
      setExpanded(false);
    };

    ownerDocument.addEventListener('pointerdown', trackOutsidePress, true);
    ownerDocument.addEventListener('click', closeOnOutside, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', trackOutsidePress, true);
      ownerDocument.removeEventListener('click', closeOnOutside, true);
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
      className={isReply ? styles.replyComposer : styles.publisher}
      data-expanded={expanded ? '' : undefined}
      onPointerDownCapture={(event) => {
        // React also captures presses in the editor's portaled pickers here.
        editorPress.current = event.nativeEvent;
      }}
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
            {isReply ? '整点回复...?' : '说点什么吧...?'}
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
              active={active && expanded}
              variant={variant}
              onCancel={discardAndClose}
              onPublish={publish}
            />
          )}
        </div>
      </div>
    </div>
  );
}
