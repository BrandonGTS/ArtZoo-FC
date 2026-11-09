'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spin } from 'antd';
import type { CheckinSummary } from '../../server/checkin/contract';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { beijingPickerTimestamp } from '../beijing-picker';
import { checkinChanged } from './checkin-events';
import './checkin.css';
/** The central avatar menu owns placement/order. Mount only this block in its existing slot. */
export default function DailyCheckinBlock({ active = true }: { active?: boolean }) {
  const { session } = useAuthSession();
  return session?.user ? (
    <CheckinContent key={session.user.id} owner={session.user.id} active={active} />
  ) : null;
}
function CheckinContent({ active, owner }: { active: boolean; owner: string }) {
  const [data, setData] = useState<CheckinSummary>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false);
  const mounted = useRef(false),
    sequence = useRef(0),
    pending = useRef(false),
    { notify, contextHolder } = useFeedbackMessage();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current || pending.current) return;
    const revision = ++sequence.current;
    try {
      const next = await accountRequest<CheckinSummary>('/api/me/check-in');
      if (mounted.current && sequence.current === revision) {
        setData(next);
        setError(undefined);
      }
    } catch (e) {
      if (mounted.current && sequence.current === revision) setError(errorDetail(e).message);
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void Promise.resolve().then(refresh);
    const update = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    // Read the latest revision when closing, not the value at subscription time.
    const invalidateReads = () => {
      ++sequence.current;
    };
    return () => {
      // Invalidate asynchronous reads on close or unmount.
      invalidateReads();
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [active, refresh]);
  useEffect(() => {
    if (!active || !data) return;
    const server = Date.parse(data.serverNow),
      midnight = beijingPickerTimestamp(data.today + 'T00:00:00') + 86400_000;
    const timer = window.setTimeout(
      () => {
        void refresh();
      },
      Math.max(100, midnight - server + 100)
    );
    return () => window.clearTimeout(timer);
  }, [active, data, refresh]);
  async function submit() {
    if (!mounted.current || pending.current || !data || data.checkedInToday || error) return;
    pending.current = true;
    ++sequence.current;
    setBusy(true);
    try {
      const result = await accountRequest<CheckinSummary>('/api/me/check-in', { method: 'POST', body: {} });
      checkinChanged(owner, result.month);
      if (!mounted.current) return;
      setData(result);
      setError(undefined);
    } catch (e) {
      if (mounted.current) notify('error', errorDetail(e).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="daily-checkin" aria-label="每日签到">
      {contextHolder}
      <div>每日签到</div>
      {data ? (
        <div className="daily-checkin-meta" aria-live="polite">
          <span>
            {Number(data.month.slice(5))}月累计 {data.count}天
          </span>
          <span className={data.checkedInToday ? 'checkin-done' : undefined}>
            {data.checkedInToday ? '今日已签到' : '今日未签到'}
          </span>
        </div>
      ) : !error ? (
        <Spin size="small" />
      ) : null}
      <ErrorNotice message={error} />
      <Button
        block
        type="primary"
        loading={busy}
        disabled={!data || !!error || data.checkedInToday}
        onClick={() => {
          void submit();
        }}
      >
        {data?.checkedInToday ? '今日已签到' : '今日签到'}
      </Button>
    </section>
  );
}
