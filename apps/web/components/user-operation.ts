// Client operation accounting only: never changes request, permission, or command semantics.
export function createUserOperationTracker() {
  const active = new Set<symbol>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => active.size,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(signal?: AbortSignal) {
      if (signal?.aborted) return () => {};
      const token = Symbol('user-operation');
      active.add(token);
      notify();
      let complete = false;
      const end = () => {
        if (complete) return;
        complete = true;
        signal?.removeEventListener('abort', end);
        active.delete(token);
        notify();
      };
      signal?.addEventListener('abort', end, { once: true });
      return end;
    }
  };
}

export const userOperations = createUserOperationTracker();
const noop = () => {};
// Client-only identity marker: never adds headers or changes the transport payload.
const silentRequests = new WeakSet<RequestInit>();
export function markBackgroundRequest<T extends RequestInit>(options: T): T {
  silentRequests.add(options);
  return options;
}

/** Begin only work the user requested. Call the returned release on unmount/cancel. */
export function beginUserOperation(signal?: AbortSignal): () => void {
  return typeof window === 'undefined' ? noop : userOperations.begin(signal);
}

/** Preserve the caller's result/error; release only this operation on any completion path. */
export async function withUserOperation<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  const end = beginUserOperation(options.signal);
  try {
    return await operation();
  } finally {
    end();
  }
}

/** Catch uploads/custom transports as well as accountRequest; background GET stays silent. */
export function installUserMutationTracking(
  target: Pick<Window, 'fetch' | 'location'>,
  navigation?: { active(): boolean; failed(): void }
) {
  const original = target.fetch;
  const owned = new Set<() => void>();
  let installed = true;
  const tracked: typeof fetch = async (input, init) => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const address = request?.url ?? String(input);
    let localMutation = false;
    try {
      const url = new URL(address, target.location.href);
      localMutation =
        url.origin === target.location.origin &&
        url.pathname.startsWith('/api/') &&
        method !== 'GET' &&
        method !== 'HEAD';
    } catch {
      /* Let fetch preserve its original invalid-URL behavior. */
    }
    const headers = new Headers(init?.headers ?? request?.headers);
    // RSC prefetch is silent. A real navigation request belongs only to an active user navigation.
    const routeRequest =
      navigation?.active() === true && headers.get('RSC') === '1' && !headers.has('Next-Router-Prefetch');
    const release =
      installed && !silentRequests.has(init ?? {}) && (localMutation || routeRequest)
        ? beginUserOperation(init?.signal ?? request?.signal ?? undefined)
        : noop;
    const end = () => {
      release();
      owned.delete(end);
    };
    owned.add(end);
    try {
      const response = await original.call(target, input, init);
      if (routeRequest && !response.ok) navigation?.failed();
      return response;
    } catch (error) {
      if (routeRequest) navigation?.failed();
      throw error;
    } finally {
      end();
    }
  };
  target.fetch = tracked;
  return () => {
    installed = false;
    if (target.fetch === tracked) target.fetch = original;
    for (const end of owned) end();
    owned.clear();
  };
}
