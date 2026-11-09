'use client';
import { useEffect, useState } from 'react';
import { useAuthSession } from '../auth-session';
import { useControlledApiRead } from '../shared/use-api-resource';
import { subscribeCheckinChanges } from '../checkin/checkin-events';
import type { LotteryView } from '../../server/lottery/contract';
export function useLotteryDetail(id: string) {
  const { session, loading: sessionLoading } = useAuthSession(),
    owner = session?.user?.id ?? null;
  const {
    snapshot: owned,
    error: currentError,
    open
  } = useControlledApiRead<LotteryView>('/api/lotteries/' + id, owner);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!owner) return;
    const request = open();
    let active = true,
      inFlight = false,
      pending = false;
    async function load(force = false) {
      if (document.visibilityState !== 'visible') return;
      if (inFlight) {
        if (force) pending = true;
        return;
      }
      inFlight = true;
      return request.read(() => {
        inFlight = false;
        if (active && pending) {
          pending = false;
          void load();
        }
      });
    }
    const refresh = () => {
      void load(true);
    };
    const unsubscribe = subscribeCheckinChanges(owner, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      request.dispose();
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [owner, id, open]);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return {
    data: owned?.data ?? null,
    error: owner ? currentError : sessionLoading ? null : '请登录后查看抽奖。',
    loading: sessionLoading || (!!owner && !owned && !currentError),
    now: owned ? Date.parse(owned.data.serverNow) + Math.max(0, elapsed - owned.received) : 0
  };
}
