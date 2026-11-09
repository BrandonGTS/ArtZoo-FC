'use client';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Button } from 'antd';
import { usePathname } from 'next/navigation';
import type { SiteHelpLessonId, SiteHelpProgress } from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { HELP_LESSONS, firstUnfinishedHelpStep } from './help-content';
import { useHelpProgress } from './use-help-progress';
import './site-help.css';
const HelpTour = lazy(() => import('./site-help-tour'));
const HelpDemo = lazy(() => import('./site-help-demo'));
const demoTarget = (selector: string) => {
  const root = document.getElementById('site-help-demo');
  const target = root?.querySelector<HTMLElement>('[data-help-selector]');
  return target?.dataset.helpSelector === selector ? target : null;
};
type HelpRun = { owner: string | null; lessonId: SiteHelpLessonId; current: number; token: number };
type HelpContext = {
  signedIn: boolean;
  progress: SiteHelpProgress | null;
  loading: boolean;
  starting: boolean;
  error: string | null;
  refresh(): Promise<SiteHelpProgress | null>;
  start(lessonId: SiteHelpLessonId, restart?: boolean): Promise<boolean>;
  cancelStart(): void;
};
const Context = createContext<HelpContext | null>(null);
export function useSiteHelp() {
  const context = useContext(Context);
  if (!context) throw Error('SiteHelpProvider is required');
  return context;
}
export default function SiteHelpProvider({ children }: { children: ReactNode }) {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  const owner = actor ? [actor.id, actor.membership, actor.adminRole].join(':') : null;
  return (
    <OwnedSiteHelpProvider owner={owner} ready={!loading}>
      {children}
    </OwnedSiteHelpProvider>
  );
}
export function OwnedSiteHelpProvider({
  children,
  owner,
  ready = true
}: {
  children: ReactNode;
  owner: string | null;
  ready?: boolean;
}) {
  const progress = useHelpProgress(owner),
    pathname = usePathname(),
    { notify, contextHolder } = useFeedbackMessage();
  const [storedRun, setRun] = useState<HelpRun | null>(null),
    [starting, setStarting] = useState(false),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const run = ready && storedRun?.owner === owner ? storedRun : null;
  const [guestProgress, setGuestProgress] = useState<SiteHelpProgress>({ lessons: [] });
  const [target, setTarget] = useState<{
    token: number;
    current: number;
    element: HTMLElement | null;
  } | null>(null);
  const active = useRef<HelpRun | null>(null),
    serial = useRef(0),
    pending = useRef(false),
    startingRef = useRef(false),
    alive = useRef(true),
    currentPath = useRef(pathname);
  const helpOwner = useRef(owner),
    ownerReady = useRef(ready);
  const invalidateRun = useCallback(() => {
    serial.current++;
    active.current = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      invalidateRun();
    };
  }, [invalidateRun]);
  useLayoutEffect(() => {
    if (helpOwner.current === owner && ownerReady.current === ready) return;
    helpOwner.current = owner;
    ownerReady.current = ready;
    invalidateRun();
    pending.current = false;
    startingRef.current = false;
    const token = serial.current;
    queueMicrotask(() => {
      if (
        alive.current &&
        serial.current === token &&
        helpOwner.current === owner &&
        ownerReady.current === ready
      ) {
        setRun(null);
        setTarget(null);
        setBusy(false);
        setStarting(false);
        setFailed(false);
        setGuestProgress({ lessons: [] });
      }
    });
  }, [owner, ready, invalidateRun]);
  const cancelStart = useCallback(() => {
    if (startingRef.current) {
      serial.current++;
      startingRef.current = false;
      setStarting(false);
    }
  }, []);
  const close = useCallback(() => {
    invalidateRun();
    pending.current = false;
    startingRef.current = false;
    setRun(null);
    setBusy(false);
    setStarting(false);
    setFailed(false);
    queueMicrotask(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="网站使用帮助"]')?.focus()
    );
  }, [invalidateRun]);
  useLayoutEffect(() => {
    const changed = currentPath.current !== pathname;
    currentPath.current = pathname;
    if (changed && startingRef.current) {
      serial.current++;
      startingRef.current = false;
      queueMicrotask(() => {
        if (alive.current && !startingRef.current) setStarting(false);
      });
    }
    if (!changed || !active.current) return;
    invalidateRun();
    pending.current = false;
    queueMicrotask(() => {
      if (alive.current && !active.current) {
        setRun(null);
        setBusy(false);
        setFailed(false);
      }
    });
  }, [pathname, invalidateRun]);
  const loadProgress = progress.refresh;
  const refresh = useCallback(() => (ready ? loadProgress() : Promise.resolve(null)), [ready, loadProgress]);
  async function start(lessonId: SiteHelpLessonId, restart = false): Promise<boolean> {
    if (
      !ready ||
      helpOwner.current !== owner ||
      !ownerReady.current ||
      startingRef.current ||
      pending.current
    )
      return false;
    const lesson = HELP_LESSONS.find((item) => item.lessonId === lessonId);
    if (!lesson) return false;
    const originPath = pathname,
      token = ++serial.current;
    startingRef.current = true;
    setStarting(true);
    try {
      const latest = owner ? await refresh() : guestProgress;
      if (!alive.current || token !== serial.current || helpOwner.current !== owner || !ownerReady.current)
        return false;
      if (currentPath.current !== originPath) {
        cancelStart();
        return false;
      }
      if (!latest) {
        notify('error', '无法读取学习进度，请重试');
        return false;
      }
      const next = { owner, lessonId, current: restart ? 0 : firstUnfinishedHelpStep(lesson, latest), token };
      active.current = next;
      setRun(next);
      setFailed(false);
      return true;
    } finally {
      if (alive.current && token === serial.current) {
        startingRef.current = false;
        setStarting(false);
      }
    }
  }
  const lesson = HELP_LESSONS.find((item) => item.lessonId === run?.lessonId),
    step = lesson?.steps[run?.current ?? 0];
  useEffect(() => {
    if (!run || !lesson || !step) return;
    const update = () => {
      if (alive.current && active.current?.token === run.token && active.current.current === run.current)
        setTarget((previous) => {
          const element = demoTarget(step.selector);
          return previous?.token === run.token &&
            previous.current === run.current &&
            previous.element === element
            ? previous
            : { token: run.token, current: run.current, element };
        });
    };
    queueMicrotask(update);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style']
    });
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [run, lesson, step, pathname]);
  const available = Boolean(
    run &&
    lesson &&
    target?.token === run.token &&
    target.current === run.current &&
    target.element?.isConnected
  );
  async function confirm() {
    if (
      !run ||
      !lesson ||
      !step ||
      !ready ||
      helpOwner.current !== owner ||
      !ownerReady.current ||
      run.owner !== owner ||
      pending.current ||
      active.current?.token !== run.token ||
      active.current.current !== run.current
    )
      return;
    if (!demoTarget(step.selector)) {
      setTarget({ token: run.token, current: run.current, element: null });
      return;
    }
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const command = { lessonId: lesson.lessonId, version: lesson.version, stepId: step.key };
      const result = owner
        ? await progress.complete(command)
        : {
            lessons: [
              ...guestProgress.lessons.filter((item) => item.lessonId !== lesson.lessonId),
              {
                lessonId: lesson.lessonId,
                version: lesson.version,
                completedStepIds: [
                  ...new Set([
                    ...(guestProgress.lessons.find((item) => item.lessonId === lesson.lessonId)
                      ?.completedStepIds ?? []),
                    step.key
                  ])
                ]
              }
            ]
          };
      if (
        !alive.current ||
        helpOwner.current !== run.owner ||
        !ownerReady.current ||
        serial.current !== run.token ||
        active.current?.current !== run.current
      )
        return;
      if (
        !result ||
        !result.lessons.some(
          (item) =>
            item.lessonId === lesson.lessonId &&
            item.version === lesson.version &&
            item.completedStepIds.includes(step.key)
        )
      ) {
        setFailed(true);
        notify('error', '未能确认本步进度，请重试');
        return;
      }
      if (!owner) setGuestProgress(result);
      if (run.current + 1 === lesson.steps.length) close();
      else {
        const next = { ...run, current: run.current + 1 };
        active.current = next;
        setRun(next);
      }
    } finally {
      if (alive.current && serial.current === run.token) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  function previous() {
    if (!run || pending.current || run.current === 0) return;
    const next = { ...run, current: run.current - 1 };
    active.current = next;
    setRun(next);
    setFailed(false);
  }
  function retryTarget() {
    if (!run || !lesson || !step) return;
    setTarget({ token: run.token, current: run.current, element: demoTarget(step.selector) });
  }
  const running = Boolean(run);
  useEffect(() => {
    if (!running) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('popstate', close);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('popstate', close);
    };
  }, [running, close]);
  return (
    <Context.Provider
      value={{
        signedIn: Boolean(owner),
        progress: !ready ? null : owner ? progress.progress : guestProgress,
        loading: progress.loading || !ready,
        starting,
        error: progress.error,
        refresh,
        start,
        cancelStart
      }}
    >
      <div className="site-help-live-page" inert={Boolean(run)} aria-hidden={run ? true : undefined}>
        {children}
      </div>
      {contextHolder}
      {run && lesson ? (
        <Suspense
          fallback={
            <section className="site-help-loading-tour" role="dialog" aria-label="正在打开引导">
              <p role="status">正在打开引导…</p>
              <Button
                autoFocus
                type="text"
                className="site-help-loading-close"
                aria-label="关闭引导"
                onClick={close}
              >
                ×
              </Button>
            </section>
          }
        >
          <HelpDemo lesson={lesson} current={run.current} onClose={close} />
          <HelpTour
            lesson={lesson}
            current={run.current}
            target={target?.token === run.token && target.current === run.current ? target.element : null}
            available={available}
            busy={busy}
            failed={failed}
            signedIn={Boolean(owner)}
            onClose={close}
            onPrevious={previous}
            onConfirm={() => void confirm()}
            onRetry={retryTarget}
          />
        </Suspense>
      ) : null}
    </Context.Provider>
  );
}
