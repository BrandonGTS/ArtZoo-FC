'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Modal } from 'antd';
import type { ActivityDetail, ActivityWriteResult } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';
import { PageHeading } from '../home-content';
import { beijingFull } from './activity-ui';
import ActivitySeriesCancellation from './activity-series-cancellation';

const seriesLabels = { RECRUITING: '招募中', FORMED: '已成团', CANCELLED: '已取消' } as const;

export function ActivitySeriesPeriods({ activity }: { activity: ActivityDetail }) {
  const series = activity.series;
  if (!series) return null;
  return (
    <section className="activity-copy-section" aria-label="长期活动期次">
      <PageHeading decoration="tomato">长期活动 · {seriesLabels[series.state]}</PageHeading>
      <p>
        第{series.periodNumber} / {series.totalPeriods}期
      </p>
      <ol>
        {series.periods.map((period) => (
          <li key={period.id}>
            <Link
              className="activity-text-link"
              href={`/activities/${period.id}`}
              aria-current={period.id === activity.id ? 'page' : undefined}
            >
              第{period.number}期
            </Link>
            {' · '}
            {beijingFull(period.startsAt)} — {beijingFull(period.endsAt)}
            {period.cancelledAt ? ' · 已取消' : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function ActivitySeriesControls({
  activity,
  now,
  onResult,
  onRefresh,
  onFeedback
}: {
  activity: ActivityDetail;
  now: number;
  onResult(result: ActivityWriteResult): void;
  onRefresh(): void;
  onFeedback(kind: 'success' | 'error', text: string): void;
}) {
  const [confirmation, setConfirmation] = useState<{ key: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const series = activity.series;
  const eligible =
    !!series &&
    series.periodNumber === 1 &&
    series.state === 'RECRUITING' &&
    activity.isOrganizer &&
    !activity.cancelledAt &&
    !activity.capacityUnlimited &&
    activity.registeredCount >= activity.capacity &&
    now < Date.parse(activity.startsAt);
  const changed = !!confirmation && confirmation.revision !== activity.revision;
  async function submit() {
    if (!eligible || !confirmation || changed || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await accountRequest<ActivityWriteResult>(
        `/api/activities/${activity.id}/series/confirm`,
        {
          method: 'POST',
          body: { idempotencyKey: confirmation.key, expectedRevision: confirmation.revision }
        }
      );
      if (!mounted.current) return;
      setConfirmation(null);
      onFeedback('success', '已确认成团');
      onResult(result);
    } catch (failure) {
      if (!mounted.current) return;
      const detail = errorDetail(failure);
      onFeedback('error', detail.message);
      if (['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(detail.code)) {
        setConfirmation(null);
        onRefresh();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!series) return null;
  return (
    <>
      <ActivitySeriesCancellation
        activity={activity}
        now={now}
        onResult={onResult}
        onRefresh={onRefresh}
        onFeedback={onFeedback}
      />
      {series.state === 'RECRUITING' &&
      activity.isOrganizer &&
      series.periodNumber === 1 &&
      !activity.cancelledAt &&
      now < Date.parse(activity.startsAt) ? (
        <div className="activity-copy-section">
          <p>
            首期开始前30分钟仍未满员，整项活动将无责取消；满员后，请在首期开始前确认成团，否则整项活动将自动取消。
          </p>
          <Button
            htmlType="button"
            type="primary"
            block
            disabled={!eligible || busy}
            onClick={() => {
              if (eligible && !pending.current)
                setConfirmation({ key: crypto.randomUUID(), revision: activity.revision });
            }}
          >
            确认成团
          </Button>
        </div>
      ) : null}
      <Modal
        open={!!confirmation}
        title="确认长期活动成团"
        okText="确认成团"
        cancelText="返回"
        confirmLoading={busy}
        onCancel={() => {
          if (!pending.current) setConfirmation(null);
        }}
        onOk={() => void submit()}
        okButtonProps={{ disabled: !eligible || changed }}
        cancelButtonProps={{ disabled: busy }}
        mask={{ closable: !busy }}
        keyboard={!busy}
      >
        <p>确认成团后，所有期次将锁定当前成员名单，并通知全体成员。确认成团吗？</p>
        {changed ? (
          <p>报名情况已变化，请返回后重新确认。</p>
        ) : !eligible && confirmation ? (
          <p>当前已不符合成团条件，请刷新详情。</p>
        ) : null}
      </Modal>
    </>
  );
}
