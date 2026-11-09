'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  SITE_HELP_COMPATIBLE_LESSONS,
  type SiteHelpProgress,
  type SiteHelpStepCommand
} from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';

/** Merge acknowledgements monotonically; an older concurrent snapshot cannot erase a completed step. */
export function mergeHelpProgress(
  previous: SiteHelpProgress | null,
  incoming: SiteHelpProgress
): SiteHelpProgress {
  if (!incoming || !Array.isArray(incoming.lessons)) throw Error('帮助进度响应无效');
  for (const row of incoming.lessons) {
    const lesson = SITE_HELP_COMPATIBLE_LESSONS.find(
      (item) => item.lessonId === row?.lessonId && item.version === row?.version
    );
    if (
      !lesson ||
      row.version !== lesson.version ||
      !Array.isArray(row.completedStepIds) ||
      row.completedStepIds.some(
        (id) => typeof id !== 'string' || !(lesson.stepIds as readonly string[]).includes(id)
      )
    )
      throw Error('帮助进度响应无效');
  }
  return {
    lessons: SITE_HELP_COMPATIBLE_LESSONS.map((lesson) => {
      const ids = new Set(
        [...(previous?.lessons ?? []), ...incoming.lessons]
          .filter((row) => row.lessonId === lesson.lessonId && row.version === lesson.version)
          .flatMap((row) => row.completedStepIds)
      );
      return {
        lessonId: lesson.lessonId,
        version: lesson.version,
        completedStepIds: lesson.stepIds.filter((id) => ids.has(id))
      };
    })
  };
}
export function useHelpProgress(owner: string | null) {
  const [state, setState] = useState<{
    owner: string;
    progress: SiteHelpProgress | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const currentOwner = useRef(owner),
    generation = useRef(0),
    reads = useRef(0);
  const requests = useRef(new Set<AbortController>()),
    inFlight = useRef(new Map<string, Promise<SiteHelpProgress | null>>());
  const snapshot = useRef<{ owner: string; progress: SiteHelpProgress } | null>(null);
  useLayoutEffect(() => {
    currentOwner.current = owner;
    const epoch = ++generation.current;
    const active = requests.current,
      pending = inFlight.current;
    return () => {
      currentOwner.current = null;
      generation.current = epoch + 1;
      active.forEach((request) => request.abort());
      active.clear();
      pending.clear();
    };
  }, [owner]);
  const perform = useCallback(
    async (command?: SiteHelpStepCommand): Promise<SiteHelpProgress | null> => {
      if (!owner) return { lessons: [] };
      if (currentOwner.current !== owner) return null;
      const epoch = generation.current,
        controller = new AbortController(),
        read = !command,
        ticket = read ? ++reads.current : 0;
      const valid = () =>
        !controller.signal.aborted && currentOwner.current === owner && generation.current === epoch;
      requests.current.add(controller);
      if (read)
        setState((previous) => ({
          owner,
          progress: previous?.owner === owner ? previous.progress : null,
          loading: true,
          error: null
        }));
      try {
        const response = await accountRequest<SiteHelpProgress>('/api/me/help-progress', {
          ...(command
            ? {
                method: 'POST' as const,
                body: { lessonId: command.lessonId, version: command.version, stepId: command.stepId }
              }
            : {}),
          signal: controller.signal,
          userInitiated: true
        });
        if (!valid()) return null;
        const progress = mergeHelpProgress(
          snapshot.current?.owner === owner ? snapshot.current.progress : null,
          response
        );
        snapshot.current = { owner, progress };
        setState((previous) => ({
          owner,
          progress,
          loading: previous?.owner === owner ? previous.loading : false,
          error: null
        }));
        return progress;
      } catch (failure) {
        if (valid())
          setState((previous) => ({
            owner,
            progress: previous?.owner === owner ? previous.progress : null,
            loading: previous?.owner === owner ? previous.loading : false,
            error: errorDetail(failure).message
          }));
        return null;
      } finally {
        requests.current.delete(controller);
        if (read && valid() && ticket === reads.current)
          setState((previous) => (previous?.owner === owner ? { ...previous, loading: false } : previous));
      }
    },
    [owner]
  );
  const refresh = useCallback(() => perform(), [perform]);
  const complete = useCallback(
    (command: SiteHelpStepCommand) => {
      const key = [owner, command.lessonId, command.version, command.stepId].join(':');
      const retained = inFlight.current.get(key);
      if (retained) return retained;
      const promise = perform(command);
      inFlight.current.set(key, promise);
      void promise.finally(() => {
        if (inFlight.current.get(key) === promise) inFlight.current.delete(key);
      });
      return promise;
    },
    [owner, perform]
  );
  const owned = state?.owner === owner ? state : null;
  return {
    progress: owned?.progress ?? null,
    loading: owned?.loading ?? false,
    error: owned?.error ?? null,
    refresh,
    complete
  };
}
