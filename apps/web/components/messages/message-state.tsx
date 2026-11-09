'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type {
  MessageRead,
  MessageUnread,
  MessageDelete,
  MessageItem,
  MessagePreview,
  MessageCategoryUnread
} from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
type State = {
  owner: string | null;
  unreadCount: number | null;
  systemUnreadCount: number | null;
  categoryUnread: MessageCategoryUnread | null;
  version: number;
  readAtById: Record<string, string>;
  externalVersion: number;
  preview: MessageItem[] | null;
  previewLoading: boolean;
  previewError: string | null;
};
type Context = {
  unreadCount: number | null;
  systemUnreadCount: number | null;
  categoryUnread: MessageCategoryUnread | null;
  version: number;
  readAtById: Record<string, string>;
  externalVersion: number;
  preview: MessageItem[] | null;
  previewLoading: boolean;
  previewError: string | null;
  refresh(): Promise<void>;
  loadPreview(): Promise<void>;
  markRead(id: string): Promise<MessageRead>;
  remove(id: string): Promise<MessageDelete>;
};
const MessageContext = createContext<Context | null>(null);
const empty = (owner: string | null): State => ({
  owner,
  unreadCount: null,
  systemUnreadCount: null,
  categoryUnread: null,
  version: 0,
  readAtById: {},
  externalVersion: 0,
  preview: null,
  previewLoading: false,
  previewError: null
});
// Only successful server responses enter this bounded, account-scoped local patch cache.
function rememberRead(previous: Record<string, string>, result: MessageRead) {
  const entries = Object.entries(previous).filter(([id]) => id !== result.id);
  return Object.fromEntries([...entries.slice(-199), [result.id, result.readAt]]);
}
export function MessageStateProvider({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuthSession(),
    owner = loading ? null : (session?.user?.id ?? null);
  const [state, setState] = useState<State>(empty(null));
  const lifetime = useRef(0),
    generation = useRef(0),
    previewGeneration = useRef(0),
    mutationEpoch = useRef(0),
    active = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null),
    previewController = useRef<AbortController | null>(null),
    previewLoaded = useRef(false);
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve()),
    pending = useRef(new Map<string, Promise<MessageRead | MessageDelete>>());
  const broadcast = useRef<BroadcastChannel | null>(null);
  if (state.owner !== owner) setState(empty(owner));
  const invalidateReads = useCallback(() => {
    ++generation.current;
    ++previewGeneration.current;
    ++mutationEpoch.current;
    controller.current?.abort();
    previewController.current?.abort();
  }, []);
  const invalidate = useCallback(() => {
    ++lifetime.current;
    invalidateReads();
  }, [invalidateReads]);
  const loadPreview = useCallback(async () => {
    if (!owner || active.current !== owner) return;
    previewLoaded.current = true;
    const stamp = ++generation.current,
      previewStamp = ++previewGeneration.current,
      life = lifetime.current,
      epoch = mutationEpoch.current;
    previewController.current?.abort();
    const abort = new AbortController();
    previewController.current = abort;
    setState((previous) => ({ ...previous, previewLoading: true, previewError: null }));
    try {
      const result = await accountRequest<MessagePreview>('/api/me/messages/preview', {
        signal: abort.signal
      });
      if (
        !abort.signal.aborted &&
        active.current === owner &&
        lifetime.current === life &&
        mutationEpoch.current === epoch &&
        previewGeneration.current === previewStamp
      )
        setState((previous) => ({
          ...previous,
          owner,
          preview: result.items,
          previewLoading: false,
          previewError: null,
          ...(generation.current === stamp
            ? {
                unreadCount: result.unreadCount,
                systemUnreadCount: result.systemUnreadCount ?? null,
                categoryUnread: result.categoryUnread ?? null
              }
            : {})
        }));
    } catch (failure) {
      if (
        !abort.signal.aborted &&
        active.current === owner &&
        lifetime.current === life &&
        mutationEpoch.current === epoch &&
        previewGeneration.current === previewStamp
      )
        setState((previous) => ({
          ...previous,
          previewLoading: false,
          previewError: errorDetail(failure).message
        }));
    }
  }, [owner]);
  const refresh = useCallback(async () => {
    if (!owner || active.current !== owner) return;
    const stamp = ++generation.current,
      life = lifetime.current,
      epoch = mutationEpoch.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await accountRequest<MessageUnread>('/api/me/messages/unread', { signal: abort.signal });
      if (
        !abort.signal.aborted &&
        active.current === owner &&
        lifetime.current === life &&
        mutationEpoch.current === epoch &&
        generation.current === stamp
      ) {
        setState((previous) => ({
          ...previous,
          owner,
          unreadCount: result.unreadCount,
          systemUnreadCount: result.systemUnreadCount ?? null,
          categoryUnread: result.categoryUnread ?? null,
          version: previous.version + 1
        }));
        if (previewLoaded.current) void loadPreview();
      }
    } catch {
      /* Keep last known count on a transient failure, never another account snapshot. */
    }
  }, [owner, loadPreview]);
  useEffect(() => {
    active.current = owner;
    invalidate();
    pending.current.clear();
    writeQueue.current = Promise.resolve();
    previewLoaded.current = false;
    let externalPending = false;
    const update = () => {
      if (document.visibilityState !== 'visible') return;
      if (externalPending) {
        externalPending = false;
        setState((previous) => ({ ...previous, externalVersion: previous.externalVersion + 1 }));
      }
      void refresh();
    };
    update();
    const timer = window.setInterval(update, 30000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel('artzoo-message-state');
        broadcast.current = channel;
        channel.onmessage = (event) => {
          const value = event.data;
          if (
            value !== 'changed' &&
            (!value || typeof value !== 'object' || value.kind !== 'changed' || value.owner !== owner)
          )
            return;
          if (active.current !== owner) return;
          // A signal is not read-state authority: current-page content and counts are fetched from the server.
          externalPending = true;
          update();
        };
      } catch {
        /* Existing focus/visibility refresh still works when this browser disables channels. */
      }
    }
    return () => {
      active.current = null;
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      broadcast.current?.close();
      broadcast.current = null;
    };
  }, [owner, refresh, invalidate]);
  const mutate = useCallback(
    (id: string, action: 'read' | 'delete'): Promise<MessageRead | MessageDelete> => {
      if (!owner || active.current !== owner) return Promise.reject(new Error('请重新登录'));
      const key = action + ':' + id,
        found = pending.current.get(key);
      if (found) return found;
      const life = lifetime.current;
      const task = writeQueue.current
        .catch(() => {})
        .then(async () => {
          if (active.current !== owner || lifetime.current !== life) throw new Error('账号状态已变化');
          invalidateReads();
          let result: MessageRead | MessageDelete;
          try {
            result = await accountRequest<MessageRead | MessageDelete>(
              `/api/me/messages/${encodeURIComponent(id)}/${action}`,
              { method: 'POST', body: {} }
            );
          } catch (failure) {
            if (active.current === owner && lifetime.current === life) {
              setState((previous) => ({ ...previous, previewLoading: false }));
              void refresh();
            }
            throw failure;
          }
          if (active.current === owner && lifetime.current === life) {
            invalidateReads();
            setState((previous) => ({
              ...previous,
              owner,
              unreadCount: result.unreadCount,
              systemUnreadCount: result.systemUnreadCount ?? null,
              categoryUnread: result.categoryUnread ?? null,
              version: previous.version + 1,
              readAtById:
                action === 'read'
                  ? rememberRead(previous.readAtById, result as MessageRead)
                  : previous.readAtById,
              preview: previous.preview?.filter((item) => item.id !== id) ?? null,
              previewLoading: false,
              previewError: null
            }));
            try {
              broadcast.current?.postMessage({ owner, kind: 'changed' });
            } catch {
              /* Server mutation remains successful if cross-tab delivery fails. */
            }
            if (previewLoaded.current) void loadPreview();
          }
          return result;
        });
      pending.current.set(key, task);
      writeQueue.current = task;
      void task.then(
        () => {
          if (pending.current.get(key) === task) pending.current.delete(key);
        },
        () => {
          if (pending.current.get(key) === task) pending.current.delete(key);
        }
      );
      return task;
    },
    [owner, invalidateReads, loadPreview, refresh]
  );
  const markRead = useCallback((id: string) => mutate(id, 'read') as Promise<MessageRead>, [mutate]);
  const remove = useCallback((id: string) => mutate(id, 'delete') as Promise<MessageDelete>, [mutate]);
  const owned = state.owner === owner;
  return (
    <MessageContext.Provider
      value={{
        unreadCount: owned ? state.unreadCount : null,
        systemUnreadCount: owned ? state.systemUnreadCount : null,
        categoryUnread: owned ? state.categoryUnread : null,
        version: owned ? state.version : 0,
        readAtById: owned ? state.readAtById : {},
        externalVersion: owned ? state.externalVersion : 0,
        preview: owned ? state.preview : null,
        previewLoading: owned && state.previewLoading,
        previewError: owned ? state.previewError : null,
        refresh,
        loadPreview,
        markRead,
        remove
      }}
    >
      {children}
    </MessageContext.Provider>
  );
}
export function useMessageState() {
  const value = useContext(MessageContext);
  if (!value) throw new Error('useMessageState requires MessageStateProvider');
  return value;
}
