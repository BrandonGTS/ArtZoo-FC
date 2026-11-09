import { albumPatch, errorDetail } from './api';
import type { useFeedbackMessage } from '../use-feedback-message';
const activeRuns = new Set<AbortController>();
export function stopReclamationRuns() {
  for (const controller of activeRuns) controller.abort();
  activeRuns.clear();
}
export interface ReclamationResponse {
  storageReclamation?: {
    status: string;
    pending: number;
    retained: number;
    legacy: number;
    targets: string[];
    authorizations?: { photoId: string; auditId: string }[];
    recovery?: { nextCursor: string | null; path: string };
    legacyNotice?: boolean;
  };
}
/** Every click owns a finite run. Stop prevents further rounds and aborts the current HTTP request;
 * already issued COS calls retain their finite timeout and are never claimed to be undone. */
export function showReclamationFeedback(
  result: ReclamationResponse,
  path: string,
  notify: ReturnType<typeof useFeedbackMessage>['notify'],
  onComplete: () => void
): boolean {
  const reclamation = result.storageReclamation;
  if (reclamation?.status === 'pending' || reclamation?.status === 'retained') {
    let busy = false;
    const dismiss = notify(
      'warning',
      reclamation.status === 'retained'
        ? '已移除照片，文件仍被其他内容使用，暂时保留。'
        : '已移除照片，文件永久删除尚未完成。',
      {
        label: '重试永久删除',
        onClick: () => {
          if (busy) return;
          busy = true;
          const controller = new AbortController();
          activeRuns.add(controller);
          let stopped = false;
          controller.signal.addEventListener(
            'abort',
            () => {
              stopped = true;
            },
            { once: true }
          );
          const stop = () => {
            stopped = true;
            controller.abort();
          };
          const dismissRunning = notify('info', '正在分批处理永久删除，可停止后再继续。', {
            label: '停止继续处理',
            onClick: stop
          });
          let state = {
            ...reclamation,
            targets: [...reclamation.targets],
            authorizations: [...(reclamation.authorizations ?? [])]
          };
          const deadline = Date.now() + 60_000;
          void (async () => {
            try {
              // At most 100 finite server rounds in a 60-second visible window. No background loop or automatic retry on failure.
              for (let round = 0; round < 100 && !stopped && Date.now() < deadline; round++) {
                const before = JSON.stringify([state.targets, state.recovery?.nextCursor]);
                let next: ReclamationResponse;
                let batchIncomplete = false;
                if (!state.targets.length && state.recovery?.nextCursor) {
                  next = await albumPatch<ReclamationResponse>(
                    state.recovery.path,
                    {
                      action: 'storage-removal-status',
                      cursor: state.recovery.nextCursor
                    },
                    { signal: controller.signal }
                  );
                } else {
                  const sent = state.targets.slice(0, 5),
                    untouched = state.targets.slice(5);
                  next = await albumPatch<ReclamationResponse>(
                    path,
                    {
                      action: 'retry-storage-removal',
                      photoIds: sent,
                      removalAuthorizations: state.authorizations.filter((a) => sent.includes(a.photoId))
                    },
                    { signal: controller.signal }
                  );
                  const n = next.storageReclamation;
                  if (!n) throw Error('未收到永久删除处理结果，请检查未完成删除。');
                  // Do not automatically retry a failed/retained target merely because its
                  // siblings succeeded. Untouched exact targets remain available for a later click.
                  batchIncomplete =
                    n.status === 'pending' ||
                    n.status === 'retained' ||
                    n.pending > 0 ||
                    n.retained > 0 ||
                    (n.targets?.length ?? 0) > 0;
                  const keep = new Set(untouched);
                  const targets = [...new Set([...(n.targets ?? []), ...untouched])];
                  next = {
                    storageReclamation: {
                      ...n,
                      targets,
                      authorizations: [
                        ...(n.authorizations ?? []),
                        ...state.authorizations.filter((a) => keep.has(a.photoId))
                      ],
                      status: untouched.length ? 'pending' : n.status,
                      pending: n.pending + untouched.length,
                      recovery: state.recovery
                    }
                  };
                }
                const n = next.storageReclamation;
                if (!n) throw Error('未收到永久删除处理结果，请检查未完成删除。');
                state = {
                  ...n,
                  targets: [...(n.targets ?? [])],
                  authorizations: [...(n.authorizations ?? [])],
                  legacy: Math.max(state.legacy ?? 0, n.legacy ?? 0),
                  legacyNotice: state.legacyNotice || n.legacyNotice
                };
                if (batchIncomplete || (!state.targets.length && !state.recovery?.nextCursor)) break;
                if (
                  state.status === 'retained' ||
                  JSON.stringify([state.targets, state.recovery?.nextCursor]) === before
                )
                  break;
              }
            } catch (error) {
              notify(
                stopped ? 'info' : 'error',
                stopped
                  ? '已停止继续处理；已发出的操作仍会核实结果。可再次重试或检查未完成删除。'
                  : errorDetail(error)
              );
            } finally {
              activeRuns.delete(controller);
              dismissRunning();
              dismiss();
              busy = false;
              if (state.targets.length || state.recovery?.nextCursor) {
                state.status = state.status === 'retained' ? 'retained' : 'pending';
                showReclamationFeedback({ storageReclamation: state }, path, notify, onComplete);
              } else {
                showReclamationFeedback(
                  { storageReclamation: { ...state, status: 'complete' } },
                  path,
                  notify,
                  onComplete
                );
                onComplete();
              }
            }
          })();
        }
      }
    );
    return true;
  }
  if (reclamation?.legacy || reclamation?.legacyNotice)
    notify('info', '本轮可回收的新照片已处理；旧照片文件按原规则保留。');
  else if (reclamation?.retained) notify('info', '已移除照片，仍被其他内容使用的文件已保留。');
  return false;
}
