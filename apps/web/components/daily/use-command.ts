import { useEffect, useRef, useState } from 'react';
import { accountRequest, errorDetail } from '../account/api';

type CommandRequest = { path: string; body: Record<string, unknown>; method: 'POST' | 'PATCH' };
type Attempt = { signature: string; key: string; uncertain: boolean; request: CommandRequest };

// Retain the normalized payload as well as its key after a lost response.
export function useDailyCommand() {
  const live = useRef(false),
    pending = useRef(false),
    attempt = useRef<Attempt | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  async function send<T>(
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'POST'
  ): Promise<T | undefined> {
    if (!live.current || pending.current) return;
    const signature = JSON.stringify({ path, method, body });
    if (attempt.current?.uncertain && attempt.current.signature !== signature)
      throw new Error('上次提交结果尚未确认，请按原内容重试。');
    if (attempt.current?.signature !== signature)
      attempt.current = {
        signature,
        key: crypto.randomUUID(),
        uncertain: false,
        request: JSON.parse(signature) as CommandRequest
      };
    const current = attempt.current;
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<T>(current.request.path, {
        method: current.request.method,
        body: { ...current.request.body, submissionKey: current.key }
      });
      if (!live.current) return;
      attempt.current = null;
      setUncertain(false);
      return result;
    } catch (error) {
      if (!live.current) return;
      const detail = errorDetail(error);
      current.uncertain = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(detail.code);
      setUncertain(current.uncertain);
      if (!current.uncertain) attempt.current = null;
      throw error;
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function retry<T>(): Promise<T | undefined> {
    const current = attempt.current;
    if (!current?.uncertain) return;
    return send<T>(current.request.path, current.request.body, current.request.method);
  }
  return { send, retry, busy, uncertain };
}
export const dailyError = (error: unknown) =>
  error instanceof Error && error.name === 'Error' ? error.message : errorDetail(error).message;
