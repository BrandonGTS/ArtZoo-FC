'use client';
import { useRef, useState } from 'react';
import { accountRequest, errorDetail } from '../account/api';
type RequestSnapshot = { path: string; body: Record<string, unknown> };
type Attempt = { signature: string; key: string; uncertain: boolean; request: RequestSnapshot };
// The retry owns the original payload, not merely its key or the current form values.
export function useWishCommand() {
  const pending = useRef(false),
    attempt = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  async function send<T>(path: string, body: Record<string, unknown>): Promise<T | undefined> {
    if (pending.current) return;
    const signature = JSON.stringify({ path, body });
    if (attempt.current?.uncertain && attempt.current.signature !== signature)
      throw new Error('提交结果尚未确认，请重试同一次提交。');
    if (attempt.current?.signature !== signature)
      attempt.current = {
        signature,
        key: crypto.randomUUID(),
        uncertain: false,
        request: JSON.parse(signature) as RequestSnapshot
      };
    const current = attempt.current;
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<T>(current.request.path, {
        method: 'POST',
        body: { ...current.request.body, idempotencyKey: current.key }
      });
      attempt.current = null;
      setUncertain(false);
      return result;
    } catch (error) {
      // Once an outcome is unknown, later failures cannot prove the first request did not commit.
      current.uncertain =
        current.uncertain ||
        ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'].includes(errorDetail(error).code);
      setUncertain(current.uncertain);
      if (!current.uncertain) attempt.current = null;
      throw error;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function retry<T>(): Promise<T | undefined> {
    const current = attempt.current;
    if (!current?.uncertain) return;
    return send<T>(current.request.path, current.request.body);
  }
  return { send, retry, busy, uncertain };
}
