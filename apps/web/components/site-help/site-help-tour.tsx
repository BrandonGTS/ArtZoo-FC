'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tour } from 'antd';
import '../activities/activity-detail-refinement.css';
import { findHelpCardPlacement, type HelpSide } from './help-placement';
import type { HelpLesson } from './help-content';
export type SiteHelpTourProps = {
  lesson: HelpLesson;
  current: number;
  target: HTMLElement | null;
  available: boolean;
  busy: boolean;
  failed: boolean;
  signedIn: boolean;
  onClose(): void;
  onPrevious(): void;
  onConfirm(): void;
  onRetry(): void;
};
export default function SiteHelpTour({
  lesson,
  current,
  target,
  available,
  busy,
  failed,
  signedIn,
  onClose,
  onPrevious,
  onConfirm,
  onRetry
}: SiteHelpTourProps) {
  const actions = useRef<HTMLDivElement | null>(null);
  const [section, setSection] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const root = section?.closest<HTMLElement>('.site-help-tour');
    if (!section || !root) return;
    let animation = 0,
      previousSide: HelpSide | undefined,
      lastRequest = '';
    const place = () => {
      if (!target?.isConnected) {
        if (root.dataset.helpPosition !== 'waiting') root.dataset.helpPosition = 'waiting';
        animation = requestAnimationFrame(place);
        return;
      }
      const visual = window.visualViewport;
      const viewport = {
        left: visual?.offsetLeft ?? 0,
        top: visual?.offsetTop ?? 0,
        right: (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth),
        bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight)
      };
      const bounds = target.getBoundingClientRect();
      const height = Math.max(section.scrollHeight, section.getBoundingClientRect().height);
      const placement = findHelpCardPlacement({
        target: bounds,
        viewport,
        width: Math.min(400, viewport.right - viewport.left - 24),
        height,
        previousSide
      });
      if (placement) {
        const values = {
          '--site-help-card-x': placement.left + 'px',
          '--site-help-card-y': placement.top + 'px',
          '--site-help-card-width': placement.width + 'px',
          '--site-help-card-max-height': placement.maxHeight + 'px'
        };
        for (const [key, value] of Object.entries(values))
          if (root.style.getPropertyValue(key) !== value) root.style.setProperty(key, value);
        if (root.dataset.helpPosition !== 'placed') root.dataset.helpPosition = 'placed';
        if (root.dataset.helpSide !== placement.side) root.dataset.helpSide = placement.side;
        previousSide = placement.side;
      } else {
        if (root.dataset.helpPosition !== 'waiting') root.dataset.helpPosition = 'waiting';
        const request = [current, viewport.right, viewport.bottom, height].join(':');
        if (request !== lastRequest) {
          lastRequest = request;
          document
            .querySelector<HTMLIFrameElement>('#site-help-demo iframe')
            ?.contentWindow?.postMessage(
              { type: 'help-make-space', lesson: lesson.lessonId, current, cardHeight: height },
              location.origin
            );
        }
      }
      animation = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(animation);
  }, [section, target, current, lesson.lessonId]);
  const focusActions = useCallback((element: HTMLDivElement | null) => {
    actions.current = element;
    setSection(element?.closest<HTMLElement>('.site-help-tour-section') ?? null);
    queueMicrotask(() => {
      if (element?.isConnected && actions.current === element)
        element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const section = actions.current?.closest('.site-help-tour-section');
      const buttons = Array.from(
        section?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]') ?? []
      ).filter((item) => item.getBoundingClientRect().width > 0);
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (!first || !last) return;
      if (
        !section?.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => document.removeEventListener('keydown', keyboard, true);
  }, [onClose]);
  return (
    <Tour
      open
      arrow={false}
      current={current}
      onClose={onClose}
      disabledInteraction
      keyboard
      gap={{ offset: 6, radius: 12 }}
      scrollIntoViewOptions={{ block: 'center', inline: 'nearest', behavior: 'auto' }}
      classNames={{
        root: 'site-help-tour',
        section: 'site-help-tour-section',
        title: 'activity-detail-field-label',
        footer: 'site-help-tour-footer'
      }}
      styles={{ section: { boxShadow: 'none' } }}
      steps={lesson.steps.map((item, index) => ({
        title: <strong>{item.title}</strong>,
        placement: 'bottom' as const,
        target: index === current ? target : null,
        description: (
          <>
            {!signedIn ? <p className="site-help-guest-note">访客体验，不记录账号进度</p> : null}
            <p>{index === current && !available ? '当前目标不可用，请重试或退出引导。' : item.description}</p>
          </>
        )
      }))}
      indicatorsRender={(index, total) => (
        <span aria-live="polite">
          {index + 1} / {total}
        </span>
      )}
      actionsRender={() => (
        <div ref={focusActions} className="site-help-tour-actions">
          <Button disabled={busy || current === 0} onClick={onPrevious}>
            上一步
          </Button>
          {!available ? <Button onClick={onRetry}>重试</Button> : null}
          <Button type="primary" disabled={busy || !available} onClick={onConfirm}>
            {failed ? '重试确认' : current + 1 === lesson.steps.length ? '完成' : '下一步'}
          </Button>
        </div>
      )}
    />
  );
}
